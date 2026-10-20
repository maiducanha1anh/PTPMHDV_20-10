const http = require('http');
const express = require('express');

const app = express();
app.use(express.json());

// Cấu hình từ biến môi trường
const PORT = parseInt(process.env.PORT || '4002', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '0', 10);
const FAIL_RATE = parseFloat(process.env.FAIL_RATE || '0');
const DROP_RATE = parseFloat(process.env.DROP_RATE || '0');

// Thống kê hoạt động của ngân hàng
const stats = {
  connections: 0,
  requests: 0,
  charges: 0,
  duplicates: 0,
};

// Lưu trữ các giao dịch đã hoàn thành
// Key: Idempotency-Key hoặc Reference
const completedTransactions = new Map();

// Lưu trữ các giao dịch đang trong quá trình xử lý (chống race condition đồng thời)
// Key -> Promise<{ statusCode, body }>
const inFlightTransactions = new Map();

// Bộ đếm tạo chargeId tự tăng
let chargeCounter = 1;

// Tập hợp lưu các reference đã thu tiền thành công để phát hiện thu trùng thực tế
const chargedReferences = new Set();

/**
 * Hàm sleep không gây nghẽn event loop
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Endpoint kiểm tra thống kê
 * Lưu ý: Không tăng stats.requests khi gọi GET /stats
 */
app.get('/stats', (req, res) => {
  return res.json({
    connections: stats.connections,
    requests: stats.requests,
    charges: stats.charges,
    duplicates: stats.duplicates,
  });
});

/**
 * Endpoint thu tiền giao dịch
 * Body: { reference: string, amount: number }
 * Header tùy chọn: Idempotency-Key
 */
app.post('/charges', async (req, res) => {
  // Quy ước: đếm các lần gọi POST /charges, bao gồm retry
  stats.requests += 1;

  const { reference, amount } = req.body || {};
  const idempotencyKey = req.headers['idempotency-key'] || (reference ? `ref_${reference}` : null);

  // 1. Kiểm tra tính hợp lệ của dữ liệu đầu vào
  if (!reference || typeof reference !== 'string' || reference.trim() === '') {
    return res.status(400).json({
      error: 'Reference is required and must be a non-empty string',
      status: 'FAILED',
    });
  }

  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || !Number.isFinite(amount)) {
    return res.status(400).json({
      error: 'Invalid amount: must be a positive integer',
      status: 'FAILED',
    });
  }

  // 2. Kiểm tra hạn mức giao dịch (tối đa 20.000.000 đồng)
  if (amount > 20000000) {
    return res.status(402).json({
      error: 'Amount exceeds limit of 20,000,000 VND',
      status: 'FAILED',
    });
  }

  // 3. Kiểm tra xem giao dịch với key này đã hoàn thành trước đó chưa
  if (idempotencyKey && completedTransactions.has(idempotencyKey)) {
    const cached = completedTransactions.get(idempotencyKey);
    // Cùng khóa nhưng khác dữ liệu phải bị từ chối
    if (cached.body && (cached.body.amount !== amount || cached.body.reference !== reference)) {
      return res.status(400).json({
        error: 'Idempotency-Key reused with different payload',
        status: 'FAILED',
      });
    }
    return res.status(cached.statusCode).json(cached.body);
  }

  // 4. Xử lý đồng thời (Race Condition) cho các yêu cầu cùng Idempotency-Key
  if (idempotencyKey && inFlightTransactions.has(idempotencyKey)) {
    const inFlight = inFlightTransactions.get(idempotencyKey);
    if (inFlight.payload && (inFlight.payload.amount !== amount || inFlight.payload.reference !== reference)) {
      return res.status(400).json({
        error: 'Idempotency-Key reused with different payload concurrently',
        status: 'FAILED',
      });
    }
    try {
      const inFlightResult = await inFlight.promise;
      return res.status(inFlightResult.statusCode).json(inFlightResult.body);
    } catch (err) {
      return res.status(500).json({
        error: 'In-flight transaction failed',
        status: 'FAILED',
      });
    }
  }

  // Tạo Deferred Promise cho in-flight request
  let resolveInFlight;
  let rejectInFlight;
  const inFlightPromise = new Promise((resolve, reject) => {
    resolveInFlight = resolve;
    rejectInFlight = reject;
  });

  if (idempotencyKey) {
    inFlightTransactions.set(idempotencyKey, {
      promise: inFlightPromise,
      payload: { reference, amount },
    });
  }

  try {
    // 5. Mô phỏng trễ (DELAY_MS)
    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }

    // 6. Mô phỏng lỗi HTTP 500 trước khi thu tiền (FAIL_RATE)
    if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) {
      const errorResponse = {
        statusCode: 500,
        body: { error: 'Internal bank server error before charge', status: 'FAILED' },
      };
      // Lỗi 500 trước khi thu tiền không lưu vào idempotency store để cho phép retry
      if (idempotencyKey) {
        resolveInFlight(errorResponse);
      }
      return res.status(errorResponse.statusCode).json(errorResponse.body);
    }

    // 7. Thực hiện thu tiền thực tế
    // Kiểm tra xem reference này đã từng thu tiền chưa (để tính duplicates chính xác)
    if (chargedReferences.has(reference)) {
      stats.duplicates += 1;
    } else {
      chargedReferences.add(reference);
      stats.charges += 1;
    }

    const chargeId = `CHG_${chargeCounter++}`;
    const successResponse = {
      statusCode: 201,
      body: {
        chargeId,
        reference,
        amount,
        status: 'PAID',
      },
    };

    // Lưu vào completedTransactions để đảm bảo tính Idempotency
    if (idempotencyKey) {
      completedTransactions.set(idempotencyKey, successResponse);
      resolveInFlight(successResponse);
    }

    // 8. Mô phỏng đứt kết nối sau khi thu tiền (DROP_RATE)
    if (DROP_RATE > 0 && Math.random() < DROP_RATE) {
      console.log(`[BANK] Simulating connection drop after charge for reference: ${reference}`);
      req.socket.destroy();
      return;
    }

    return res.status(successResponse.statusCode).json(successResponse.body);
  } catch (error) {
    if (idempotencyKey) {
      rejectInFlight(error);
    }
    console.error('[BANK] Unexpected error processing charge:', error);
    return res.status(500).json({
      error: 'Unexpected server error',
      status: 'FAILED',
    });
  } finally {
    if (idempotencyKey) {
      inFlightTransactions.delete(idempotencyKey);
    }
  }
});

// Khởi tạo HTTP server
const server = http.createServer(app);

// Đếm kết nối TCP thực tế
server.on('connection', (socket) => {
  stats.connections += 1;
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[BANK] [TCP] New TCP connection from ${remote} (Total: ${stats.connections})`);

  socket.on('close', (hadError) => {
    console.log(`[BANK] [TCP] Socket closed from ${remote} (hadError: ${hadError})`);
  });
});

// Giữ kết nối nhàn rỗi tối đa 5 giây theo yêu cầu đề bài
server.keepAliveTimeout = 5000;
// headersTimeout phải lớn hơn keepAliveTimeout theo khuyến nghị của Node.js
server.headersTimeout = 6000;

server.listen(PORT, () => {
  console.log(`[BANK] Bank Service is listening on port ${PORT}`);
  console.log(`[BANK] Configuration: DELAY_MS=${DELAY_MS}, FAIL_RATE=${FAIL_RATE}, DROP_RATE=${DROP_RATE}`);
});
