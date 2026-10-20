const express = require('express');
const BankClient = require('./bank-client');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '4001', 10);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';

const bankClient = new BankClient(BANK_URL);

// Dữ liệu ban đầu trong bộ nhớ theo đề bài:
// Sinh viên 1: nợ 50.000.000 đồng.
// Sinh viên 2: nợ 0 đồng.
// Sinh viên 3: nợ 3.200.000 đồng.
const students = new Map([
  [1, { id: 1, debt: 50000000, reservedDebt: 0 }],
  [2, { id: 2, debt: 0, reservedDebt: 0 }],
  [3, { id: 3, debt: 3200000, reservedDebt: 0 }],
]);

// Lưu trữ các lệnh thanh toán: paymentId -> paymentRecord
const payments = new Map();

// Bộ đếm tạo mã paymentId: P1, P2, P3...
let paymentCounter = 1;

/**
 * GET /students/:id/fees
 * Lấy công nợ của sinh viên
 */
app.get('/students/:id/fees', (req, res) => {
  const studentId = parseInt(req.params.id, 10);
  const student = students.get(studentId);

  if (!student) {
    return res.status(404).json({
      error: 'Student not found',
    });
  }

  // Trả về công nợ của sinh viên
  return res.json({
    studentId: student.id,
    debt: student.debt,
  });
});

/**
 * POST /students/:id/payments
 * Body JSON: { "amount": 100000 }
 */
app.post('/students/:id/payments', async (req, res) => {
  // Ghi nhận thời điểm bắt đầu tại thời điểm Fee Service nhận yêu cầu
  const requestStartTime = Date.now();
  const TOTAL_PAYMENT_BUDGET_MS = 4000;
  const deadline = requestStartTime + TOTAL_PAYMENT_BUDGET_MS;

  const studentId = parseInt(req.params.id, 10);
  const { amount } = req.body || {};

  // 1. Kiểm tra sinh viên có tồn tại không
  const student = students.get(studentId);
  if (!student) {
    return res.status(404).json({
      error: 'Student not found',
      paymentId: null,
      status: 'FAILED',
    });
  }

  // 2. Kiểm tra tính hợp lệ của số tiền thanh toán (phải là số nguyên dương hữu hạn)
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || !Number.isFinite(amount)) {
    return res.status(400).json({
      error: 'Invalid amount: must be a positive integer',
      paymentId: null,
      status: 'FAILED',
    });
  }

  // 3. Kiểm soát thanh toán đồng thời (Concurrency Control):
  // Không cho phép nhận tổng tiền vượt quá công nợ khả dụng
  const availableDebt = student.debt - student.reservedDebt;
  if (amount > availableDebt) {
    return res.status(400).json({
      error: 'Amount exceeds outstanding available debt',
      paymentId: null,
      status: 'FAILED',
    });
  }

  // 4. Tạo mã lệnh thanh toán tuần tự: P1, P2...
  const paymentId = `P${paymentCounter++}`;

  // Tạm giữ (reserve) công nợ để tránh vượt hạn mức khi có request đồng thời
  student.reservedDebt += amount;

  const paymentRecord = {
    paymentId,
    studentId: student.id,
    amount,
    status: 'PENDING',
    createdAt: new Date(),
  };
  payments.set(paymentId, paymentRecord);

  // Tính ngân sách thời gian còn lại trước khi gọi ngân hàng
  const remainingTimeoutMs = Math.max(0, deadline - Date.now());
  if (remainingTimeoutMs <= 0) {
    student.reservedDebt -= amount;
    paymentRecord.status = 'FAILED';
    return res.status(504).json({
      error: 'Payment budget expired before calling bank',
      paymentId,
      status: 'PENDING',
    });
  }

  try {
    // 5. Gọi Ngân hàng để thu tiền với deadline tổng
    const bankResult = await bankClient.charge({
      reference: paymentId,
      amount,
      idempotencyKey: paymentId,
      deadline,
      timeoutMs: remainingTimeoutMs,
    });

    // 6. Xử lý phản hồi theo quy ước kết quả thanh toán (Mục 1.5 & Giai đoạn 4)
    if (bankResult.success && bankResult.status === 'PAID') {
      // THÀNH CÔNG: HTTP 201 PAID
      // Giảm công nợ thực tế đúng 1 lần cho mỗi lệnh, giải phóng khoản dự trữ đúng 1 lần
      student.debt -= amount;
      student.reservedDebt -= amount;

      paymentRecord.status = 'PAID';
      paymentRecord.chargeId = bankResult.data.chargeId;

      return res.status(201).json({
        paymentId,
        studentId: student.id,
        amount,
        status: 'PAID',
        remainingDebt: student.debt,
        chargeId: bankResult.data.chargeId,
      });
    }

    if (bankResult.status === 'PENDING' || bankResult.statusCode === 504) {
      // KHÔNG RÕ KẾT QUẢ: 504 PENDING
      // Giữ nguyên công nợ thực tế và giữ nguyên khoản dự trữ để bảo vệ công nợ khả dụng
      paymentRecord.status = 'PENDING';
      return res.status(504).json({
        error: bankResult.error,
        paymentId,
        status: 'PENDING',
      });
    }

    // THẤT BẠI RÕ RÀNG / CHẮC CHẮN CHƯA THU TIỀN: FAILED
    // Hoàn lại khoản dự trữ (reservedDebt)
    student.reservedDebt -= amount;
    paymentRecord.status = 'FAILED';

    return res.status(bankResult.statusCode || 503).json({
      error: bankResult.error || 'Payment failed',
      paymentId,
      status: 'FAILED',
    });
  } catch (err) {
    // Trường hợp lỗi bất ngờ phát sinh trong Fee Service
    student.reservedDebt -= amount;
    paymentRecord.status = 'FAILED';
    console.error(`[FEE] Unexpected error processing payment ${paymentId}:`, err);

    return res.status(500).json({
      error: 'Internal fee service error',
      paymentId,
      status: 'FAILED',
    });
  }
});

app.listen(PORT, () => {
  console.log(`[FEE] Fee Service is listening on port ${PORT}`);
  console.log(`[FEE] Configured BANK_URL: ${BANK_URL}`);
});
