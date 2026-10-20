const http = require('http');

/**
 * Hàm sleep không gây nghẽn event loop
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Client giao tiếp với Ngân hàng giả lập
 * Hỗ trợ HTTP Keep-Alive Pool, Quản lý Deadline và Retry có chọn lọc
 */
class BankClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl || process.env.BANK_URL || 'http://localhost:4002';
    // Dùng một http.Agent duy nhất dùng chung với keepAlive: true và maxSockets: 10
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: 10,
      keepAliveMsecs: 1000,
    });
  }

  /**
   * Thực hiện một lần gọi HTTP duy nhất tới Ngân hàng
   * @private
   */
  _executeSingleAttempt({ reference, amount, idempotencyKey, deadline }) {
    return new Promise((resolve) => {
      const remainingMs = Math.max(0, deadline - Date.now());

      if (remainingMs <= 0) {
        return resolve({
          success: false,
          type: 'TIMEOUT',
          statusCode: 504,
          error: 'Payment budget expired before socket acquisition',
        });
      }

      const url = new URL('/charges', this.baseUrl);
      const postData = JSON.stringify({ reference, amount });

      let isFinished = false;
      let timer = null;

      const finish = (result) => {
        if (isFinished) return;
        isFinished = true;

        if (timer) {
          clearTimeout(timer);
          timer = null;
        }

        resolve(result);
      };

      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        agent: this.agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      };

      let requestSent = false;

      const req = http.request(options, (res) => {
        let responseBody = '';
        res.setEncoding('utf8');

        // Tiêu thụ stream dữ liệu thực tế
        res.on('data', (chunk) => {
          if (isFinished) return;
          responseBody += chunk;
        });

        res.on('end', () => {
          if (isFinished) return;

          let parsedData = {};
          try {
            parsedData = JSON.parse(responseBody);
          } catch (e) {
            parsedData = { raw: responseBody };
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            return finish({
              success: true,
              statusCode: res.statusCode,
              data: parsedData,
            });
          }

          if (res.statusCode === 500) {
            return finish({
              success: false,
              type: 'SERVER_ERROR',
              statusCode: 500,
              error: parsedData.error || 'Internal bank server error before charge',
              data: parsedData,
            });
          }

          // Mã từ chối nghiệp vụ rõ ràng (400, 402...)
          return finish({
            success: false,
            type: 'REJECTED',
            statusCode: res.statusCode,
            error: parsedData.error || `Bank rejected with HTTP ${res.statusCode}`,
            data: parsedData,
          });
        });

        res.on('error', (err) => {
          if (isFinished) return;
          return finish({
            success: false,
            type: 'CONNECTION_DROPPED',
            statusCode: 504,
            error: err.message || 'Response stream error',
          });
        });

        res.on('aborted', () => {
          if (isFinished) return;
          return finish({
            success: false,
            type: 'CONNECTION_DROPPED',
            statusCode: 504,
            error: 'Response aborted by server',
          });
        });
      });

      // Timer quản lý ngân sách còn lại của lần gọi
      timer = setTimeout(() => {
        if (isFinished) return;
        req.destroy(new Error('TIMEOUT'));
        finish({
          success: false,
          type: 'TIMEOUT',
          statusCode: 504,
          error: 'Bank request timed out',
        });
      }, remainingMs);

      // Bắt các lỗi socket và mạng
      req.on('error', (err) => {
        if (isFinished) return;

        if (err.message === 'TIMEOUT') {
          return;
        }

        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          // Chưa thiết lập được kết nối -> Chắc chắn chưa thu tiền -> 503 FAILED
          return finish({
            success: false,
            type: 'CONNECTION_REFUSED',
            statusCode: 503,
            error: 'Cannot connect to bank service',
          });
        }

        if (err.code === 'ECONNRESET' || err.message === 'socket hang up') {
          // Đứt kết nối trong lúc đang chờ phản hồi -> 504 PENDING
          return finish({
            success: false,
            type: 'CONNECTION_DROPPED',
            statusCode: 504,
            error: 'Connection dropped while waiting for bank response',
          });
        }

        return finish({
          success: false,
          type: 'NETWORK_ERROR',
          statusCode: requestSent ? 504 : 503,
          error: err.message || 'Unknown network error',
        });
      });

      req.write(postData);
      req.end();
      requestSent = true;
    });
  }

  /**
   * Gọi API thu tiền /charges với cơ chế Retry có chọn lọc và phân loại lịch sử
   * @param {Object} params
   * @param {string} params.reference - Mã lệnh thanh toán (P1, P2...)
   * @param {number} params.amount - Số tiền thanh toán
   * @param {string} params.idempotencyKey - Khóa chống trùng lặp
   * @param {number} [params.deadline] - Timestamp kết thúc ngân sách xử lý tính từ lúc Fee Service nhận request
   * @param {number} [params.timeoutMs=4000] - Thời gian ngân sách dự phòng
   * @returns {Promise<Object>} Kết quả tổng hợp phân loại theo lịch sử
   */
  async charge({ reference, amount, idempotencyKey, deadline, timeoutMs = 4000 }) {
    const finalDeadline = deadline || (Date.now() + timeoutMs);
    const MAX_ATTEMPTS = 3;
    const BACKOFF_DELAYS = [100, 200]; // Chờ 100ms sau lần 1, 200ms sau lần 2

    const history = [];
    let hadDropOrTimeout = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 1. Kiểm tra ngân sách trước khi thử
      if (Date.now() >= finalDeadline) {
        break;
      }

      // 2. Thực hiện 1 lần gọi với cùng reference, amount, Idempotency-Key
      const result = await this._executeSingleAttempt({
        reference,
        amount,
        idempotencyKey,
        deadline: finalDeadline,
      });

      history.push({ attempt, ...result });

      // Ghi nhận nếu có lần nào mất phản hồi có khả năng ngân hàng đã thu tiền
      if (result.type === 'CONNECTION_DROPPED' || result.type === 'TIMEOUT') {
        hadDropOrTimeout = true;
      }

      // 3. THÀNH CÔNG: HTTP 201 PAID
      if (result.success && result.statusCode === 201) {
        return {
          success: true,
          status: 'PAID',
          statusCode: 201,
          data: result.data,
          history,
        };
      }

      // 4. BỊ TỪ CHỐI NGHIỆP VỤ RÕ RÀNG (400, 402...): KHÔNG RETRY
      if (result.type === 'REJECTED') {
        if (!hadDropOrTimeout) {
          // Chắc chắn chưa thu tiền
          return {
            success: false,
            status: 'FAILED',
            statusCode: result.statusCode,
            error: result.error,
            data: result.data,
            history,
          };
        } else {
          // Đã từng có lần rớt kết nối trước đó -> Không thể kết luận an toàn là FAILED
          return {
            success: false,
            status: 'PENDING',
            statusCode: 504,
            error: result.error || 'Ambiguous state after previous connection drop',
            history,
          };
        }
      }

      // 5. KHÔNG KẾT NỐI ĐƯỢC TỚI NGÂN HÀNG (ECONNREFUSED):
      // Khi ngân hàng tắt ngay từ đầu, trả 503 FAILED nhanh dưới 1.500 ms theo Tình huống 1
      if (result.type === 'CONNECTION_REFUSED') {
        if (!hadDropOrTimeout) {
          return {
            success: false,
            status: 'FAILED',
            statusCode: 503,
            error: result.error || 'Cannot connect to bank service',
            history,
          };
        } else {
          return {
            success: false,
            status: 'PENDING',
            statusCode: 504,
            error: 'Cannot connect to bank after previous connection drop',
            history,
          };
        }
      }

      // 6. LỖI TẠM THỜI CÓ THỂ RETRY (SERVER_ERROR 500 hoặc CONNECTION_DROPPED / TIMEOUT)
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = BACKOFF_DELAYS[attempt - 1] || 100;
        const remainingBeforeDelay = finalDeadline - Date.now();
        if (remainingBeforeDelay <= delayMs) {
          // Không đủ ngân sách chờ delay trước deadline
          break;
        }
        await sleep(delayMs);
      }
    }

    // 7. PHÂN LOẠI KẾT QUẢ CUỐI CÙNG THEO LỊCH SỬ KHI HẾT LƯỢT HOẶC HẾT NGÂN SÁCH
    if (hadDropOrTimeout) {
      // Đã từng mất phản hồi có khả năng ngân hàng đã thu tiền -> 504 PENDING
      return {
        success: false,
        status: 'PENDING',
        statusCode: 504,
        error: 'Bank request timed out or connection dropped during charge attempts',
        history,
      };
    }

    // Tất cả các lần thử chỉ gặp lỗi 500 trước khi thu tiền -> Chắc chắn chưa thu tiền -> 503 FAILED
    const lastError = history[history.length - 1]?.error || 'Bank internal error before charging';
    return {
      success: false,
      status: 'FAILED',
      statusCode: 503,
      error: lastError,
      history,
    };
  }
}

module.exports = BankClient;
