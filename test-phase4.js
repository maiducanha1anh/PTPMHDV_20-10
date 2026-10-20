/**
 * Script kiểm thử tự động Giai đoạn 4:
 * Xử lý lỗi tạm thời (FAIL_RATE), đứt kết nối (DROP_RATE), từ chối nghiệp vụ và kiểm tra có kiểm soát
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const FEE_URL = 'http://localhost:4001';
const BANK_URL = 'http://localhost:4002';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let bankProcess = null;
let feeProcess = null;
let bankLogs = [];

function startBank(envVars = {}) {
  return new Promise((resolve) => {
    bankLogs = [];
    bankProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, 'bank-service'),
      env: { ...process.env, DELAY_MS: '0', FAIL_RATE: '0', DROP_RATE: '0', ...envVars },
      stdio: 'pipe',
    });

    bankProcess.stdout.on('data', (d) => {
      const text = d.toString();
      bankLogs.push(text);
      if (text.includes('Bank Service is listening')) {
        resolve();
      }
    });

    setTimeout(resolve, 1500);
  });
}

function stopBank() {
  if (bankProcess) {
    try { bankProcess.kill('SIGKILL'); } catch (e) {}
    bankProcess = null;
  }
}

function startFee(envVars = {}) {
  return new Promise((resolve) => {
    feeProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, 'fee-service'),
      env: { ...process.env, BANK_URL: 'http://localhost:4002', ...envVars },
      stdio: 'pipe',
    });

    feeProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Fee Service is listening')) {
        resolve();
      }
    });

    setTimeout(resolve, 1500);
  });
}

function stopFee() {
  if (feeProcess) {
    try { feeProcess.kill('SIGKILL'); } catch (e) {}
    feeProcess = null;
  }
}

async function runPhase4Tests() {
  console.log('====================================================');
  console.log('BẮT ĐẦU KIỂM THỬ TOÀN DIỆN GIAI ĐOẠN 4');
  console.log('====================================================\n');

  const report = {};

  try {
    // -------------------------------------------------------------------
    // KỊCH BẢN 4.A: DROP_RATE = 0.3 (60 thanh toán lần lượt, mỗi lần 1.000đ)
    // -------------------------------------------------------------------
    console.log('>>> KỊCH BẢN 4.A: DROP_RATE = 0.3 (60 thanh toán lần lượt) <<<');
    stopBank();
    stopFee();
    await sleep(500);

    await startBank({ DROP_RATE: '0.3', FAIL_RATE: '0', DELAY_MS: '0' });
    await startFee();
    await sleep(500);

    const statsBefore4A = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeBefore4A = await (await fetch(`${FEE_URL}/students/1/fees`)).json();
    console.log(`[Setup 4A] Stats ban đầu:`, statsBefore4A);
    console.log(`[Setup 4A] Công nợ ban đầu: ${feeBefore4A.debt}đ`);

    let paidCount4A = 0;
    let pendingCount4A = 0;
    let failedCount4A = 0;
    const durations4A = [];
    const pendingDetails4A = [];

    const start4A = performance.now();
    for (let i = 1; i <= 60; i++) {
      const t0 = performance.now();
      const res = await fetch(`${FEE_URL}/students/1/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1000 }),
      });
      const dur = Math.round(performance.now() - t0);
      durations4A.push(dur);
      const data = await res.json();

      if (res.status === 201 && data.status === 'PAID') {
        paidCount4A++;
      } else if (res.status === 504 && data.status === 'PENDING') {
        pendingCount4A++;
        pendingDetails4A.push({ index: i, paymentId: data.paymentId, error: data.error });
      } else {
        failedCount4A++;
      }
    }
    const totalTime4A = Math.round(performance.now() - start4A);
    const maxDur4A = Math.max(...durations4A);

    const statsAfter4A = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeAfter4A = await (await fetch(`${FEE_URL}/students/1/fees`)).json();

    const actualDebtReduced4A = feeBefore4A.debt - feeAfter4A.debt;
    const expectedDebtReduced4A = paidCount4A * 1000;

    console.log(`\nKết quả Kịch bản 4.A (DROP_RATE=0.3):`);
    console.log(`- Số lệnh PAID: ${paidCount4A} / 60 (Tiêu chí: >= 54)`);
    console.log(`- Số lệnh PENDING: ${pendingCount4A}`);
    console.log(`- Số lệnh FAILED: ${failedCount4A}`);
    console.log(`- Ngân hàng charges: ${statsAfter4A.charges}`);
    console.log(`- Ngân hàng requests (bao gồm retry): ${statsAfter4A.requests}`);
    console.log(`- Ngân hàng duplicates: ${statsAfter4A.duplicates} (Tiêu chí: luôn = 0)`);
    console.log(`- Thời gian lớn nhất (maxDuration): ${maxDur4A} ms`);
    console.log(`- Công nợ giảm: ${actualDebtReduced4A}đ (Kỳ vọng: ${expectedDebtReduced4A}đ)`);

    // Đối chiếu charges và PAID nếu có chênh lệch
    if (statsAfter4A.charges > paidCount4A) {
      console.log(`- Ghi chú đối chiếu: Có ${statsAfter4A.charges - paidCount4A} giao dịch đã trừ tiền ở Ngân hàng nhưng bị drop cả 3 lần nên client nhận PENDING:`, pendingDetails4A);
    }

    const pass4A_paid = paidCount4A >= 54;
    const pass4A_dup = statsAfter4A.duplicates === 0;
    const pass4A_debt = actualDebtReduced4A === expectedDebtReduced4A;

    console.log(`[4A.1] Tiêu chí PAID >= 54/60 -> ${pass4A_paid ? 'PASS' : 'FAIL'} (${paidCount4A}/60)`);
    console.log(`[4A.2] Tiêu chí duplicates = 0 -> ${pass4A_dup ? 'PASS' : 'FAIL'}`);
    console.log(`[4A.3] Tiêu chí công nợ chỉ giảm đúng số lệnh PAID -> ${pass4A_debt ? 'PASS' : 'FAIL'}`);

    report.kịch_bản_4A = {
      paid: paidCount4A,
      pending: pendingCount4A,
      failed: failedCount4A,
      charges: statsAfter4A.charges,
      requests: statsAfter4A.requests,
      duplicates: statsAfter4A.duplicates,
      maxDurationMs: maxDur4A,
      debtReduced: actualDebtReduced4A,
      passed: pass4A_paid && pass4A_dup && pass4A_debt,
    };

    // -------------------------------------------------------------------
    // KỊCH BẢN 4.B: FAIL_RATE = 0.3 (60 thanh toán lần lượt, mỗi lần 1.000đ)
    // -------------------------------------------------------------------
    console.log('\n>>> KỊCH BẢN 4.B: FAIL_RATE = 0.3 (60 thanh toán lần lượt) <<<');
    stopBank();
    stopFee();
    await sleep(500);

    await startBank({ FAIL_RATE: '0.3', DROP_RATE: '0', DELAY_MS: '0' });
    await startFee();
    await sleep(500);

    const statsBefore4B = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeBefore4B = await (await fetch(`${FEE_URL}/students/1/fees`)).json();
    console.log(`[Setup 4B] Stats ban đầu:`, statsBefore4B);

    let paidCount4B = 0;
    let pendingCount4B = 0;
    let failedCount4B = 0;
    const durations4B = [];

    const start4B = performance.now();
    for (let i = 1; i <= 60; i++) {
      const t0 = performance.now();
      const res = await fetch(`${FEE_URL}/students/1/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1000 }),
      });
      const dur = Math.round(performance.now() - t0);
      durations4B.push(dur);
      const data = await res.json();

      if (res.status === 201 && data.status === 'PAID') {
        paidCount4B++;
      } else if (res.status === 504 && data.status === 'PENDING') {
        pendingCount4B++;
      } else if (res.status === 503 && data.status === 'FAILED') {
        failedCount4B++;
      }
    }
    const totalTime4B = Math.round(performance.now() - start4B);
    const maxDur4B = Math.max(...durations4B);

    const statsAfter4B = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeAfter4B = await (await fetch(`${FEE_URL}/students/1/fees`)).json();

    const actualDebtReduced4B = feeBefore4B.debt - feeAfter4B.debt;
    const expectedDebtReduced4B = paidCount4B * 1000;

    console.log(`\nKết quả Kịch bản 4.B (FAIL_RATE=0.3):`);
    console.log(`- Số lệnh PAID: ${paidCount4B} / 60 (Tiêu chí: >= 54)`);
    console.log(`- Số lệnh FAILED (hết lượt retry 500): ${failedCount4B}`);
    console.log(`- Số lệnh PENDING: ${pendingCount4B}`);
    console.log(`- Ngân hàng charges: ${statsAfter4B.charges}`);
    console.log(`- Ngân hàng requests: ${statsAfter4B.requests}`);
    console.log(`- Ngân hàng duplicates: ${statsAfter4B.duplicates} (Tiêu chí: 0)`);
    console.log(`- Công nợ giảm: ${actualDebtReduced4B}đ (Kỳ vọng: ${expectedDebtReduced4B}đ)`);

    const pass4B_paid = paidCount4B >= 54;
    const pass4B_dup = statsAfter4B.duplicates === 0;
    const pass4B_debt = actualDebtReduced4B === expectedDebtReduced4B;

    console.log(`[4B.1] Tiêu chí PAID >= 54/60 -> ${pass4B_paid ? 'PASS' : 'FAIL'} (${paidCount4B}/60)`);
    console.log(`[4B.2] Tiêu chí duplicates = 0 -> ${pass4B_dup ? 'PASS' : 'FAIL'}`);
    console.log(`[4B.3] Tiêu chí công nợ chỉ giảm đúng số lệnh PAID -> ${pass4B_debt ? 'PASS' : 'FAIL'}`);

    report.kịch_bản_4B = {
      paid: paidCount4B,
      pending: pendingCount4B,
      failed: failedCount4B,
      charges: statsAfter4B.charges,
      requests: statsAfter4B.requests,
      duplicates: statsAfter4B.duplicates,
      maxDurationMs: maxDur4B,
      debtReduced: actualDebtReduced4B,
      passed: pass4B_paid && pass4B_dup && pass4B_debt,
    };

    // -------------------------------------------------------------------
    // KỊCH BẢN 4.C: TỪ CHỐI HẠN MỨC (25.000.000đ)
    // -------------------------------------------------------------------
    console.log('\n>>> KỊCH BẢN 4.C: Từ chối hạn mức (25.000.000đ) <<<');
    stopBank();
    stopFee();
    await sleep(500);

    await startBank({ FAIL_RATE: '0', DROP_RATE: '0', DELAY_MS: '0' });
    await startFee();
    await sleep(500);

    const statsBefore4C = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeBefore4C = await (await fetch(`${FEE_URL}/students/1/fees`)).json();

    const res4C = await fetch(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 25000000 }),
    });
    const data4C = await res4C.json();

    const statsAfter4C = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeAfter4C = await (await fetch(`${FEE_URL}/students/1/fees`)).json();

    const requestsDelta4C = statsAfter4C.requests - statsBefore4C.requests;
    const chargesDelta4C = statsAfter4C.charges - statsBefore4C.charges;
    const debtChanged4C = feeBefore4C.debt !== feeAfter4C.debt;

    console.log(`Kết quả Kịch bản 4.C:`);
    console.log(`- Mã HTTP: ${res4C.status}, Body:`, data4C);
    console.log(`- Requests ngân hàng tăng: ${requestsDelta4C} (Yêu cầu: đúng 1, không retry)`);
    console.log(`- Charges tăng: ${chargesDelta4C} (Yêu cầu: 0)`);
    console.log(`- Công nợ thay đổi: ${debtChanged4C ? 'CÓ (Lỗi)' : 'KHÔNG (Đúng)'}`);

    const pass4C = res4C.status === 402 && requestsDelta4C === 1 && chargesDelta4C === 0 && !debtChanged4C;
    console.log(`[4C] Tiêu chí: Trả 402, requests tăng đúng 1, charges & nợ không đổi -> ${pass4C ? 'PASS' : 'FAIL'}`);

    report.kịch_bản_4C = {
      statusCode: res4C.status,
      requestsDelta: requestsDelta4C,
      chargesDelta: chargesDelta4C,
      debtChanged: debtChanged4C,
      passed: pass4C,
    };

    // -------------------------------------------------------------------
    // KỊCH BẢN 4.D: KIỂM TRA LỖI HỖN HỢP BẰNG TEST CÓ KIỂM SOÁT
    // (Lần 1: trừ tiền rồi drop; Lần 2-3: trả 500. Kết quả phải là 504 PENDING!)
    // -------------------------------------------------------------------
    console.log('\n>>> KỊCH BẢN 4.D: Kiểm tra có kiểm soát (Lần 1 drop, lần 2-3 lỗi 500) <<<');

    // Tạo một mock server HTTP độc lập trên cổng 4099 mô phỏng kịch bản có kiểm soát
    let attemptCount = 0;
    const mockServer = http.createServer((req, res) => {
      attemptCount++;
      if (attemptCount === 1) {
        // Lần 1: Giả lập đã trừ tiền rồi cắt kết nối
        console.log(`[Mock Bank 4D] Lần 1: Thu tiền xong rồi destroy socket...`);
        req.socket.destroy();
        return;
      }
      // Lần 2 và 3: Trả lỗi HTTP 500
      console.log(`[Mock Bank 4D] Lần ${attemptCount}: Trả lỗi HTTP 500...`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Mock bank 500 error', status: 'FAILED' }));
    });

    await new Promise((resolve) => mockServer.listen(4099, resolve));
    console.log('[Mock Bank 4D] Đang chạy tại http://localhost:4099');

    // Dùng BankClient gọi tới mock server này
    const BankClient = require('./fee-service/bank-client');
    const testClient = new BankClient('http://localhost:4099');

    const mixedResult = await testClient.charge({
      reference: 'MOCK_MIXED_P1',
      amount: 1000,
      idempotencyKey: 'IDEMP_MIXED_P1',
      deadline: Date.now() + 4000,
    });

    console.log(`Kết quả phân loại của BankClient khi lỗi hỗn hợp:`);
    console.log(`- Status: ${mixedResult.status}`);
    console.log(`- StatusCode: ${mixedResult.statusCode}`);
    console.log(`- Số lần thử thực tế: ${mixedResult.history.length}`);
    console.log(`- Lịch sử các lần thử:`, mixedResult.history.map(h => ({ attempt: h.attempt, type: h.type, statusCode: h.statusCode })));

    mockServer.close();

    const pass4D = mixedResult.status === 'PENDING' && mixedResult.statusCode === 504 && mixedResult.history.length === 3;
    console.log(`[4D] Tiêu chí: Phân loại đúng 504 PENDING (không bị nhầm FAILED) sau 3 lần thử -> ${pass4D ? 'PASS' : 'FAIL'}`);

    report.kịch_bản_4D = {
      status: mixedResult.status,
      statusCode: mixedResult.statusCode,
      attempts: mixedResult.history.length,
      passed: pass4D,
    };

    // -------------------------------------------------------------------
    // RÀ SOÁT GIAI ĐOẠN 3: KIỂM TRA NHÀN RỖI ĐÚNG 6.000 MS
    // -------------------------------------------------------------------
    console.log('\n>>> RÀ SOÁT GIAI ĐOẠN 3: Kiểm tra nhàn rỗi cấu hình đúng 6.000 ms <<<');
    stopBank();
    stopFee();
    await sleep(500);

    await startBank({ DELAY_MS: '0', FAIL_RATE: '0', DROP_RATE: '0' });
    await startFee();
    await sleep(500);

    // Gửi 10 thanh toán để mở 10 socket trong pool
    console.log('Gửi 10 thanh toán ban đầu...');
    await Promise.all(Array.from({ length: 10 }, () =>
      fetch(`${FEE_URL}/students/1/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1000 }),
      })
    ));

    const socketsBeforeIdle = bankLogs.join('').split('[BANK] [TCP] Socket closed').length - 1;

    console.log('Bắt đầu đo nhàn rỗi đúng 6.000 ms...');
    const idleT0 = performance.now();
    await sleep(6000);
    const idleActualMs = Math.round(performance.now() - idleT0);

    const socketsAfterIdle = bankLogs.join('').split('[BANK] [TCP] Socket closed').length - 1;
    const closedCount = socketsAfterIdle - socketsBeforeIdle;
    console.log(`Thời gian chờ nhàn rỗi thực tế: ${idleActualMs} ms`);
    console.log(`Số socket đóng được ghi nhận từ log: ${closedCount}`);

    // Gửi tiếp 1 thanh toán mới
    const resAfterIdle = await fetch(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1000 }),
    });
    const dataAfterIdle = await resAfterIdle.json();
    console.log(`Thanh toán sau nhàn rỗi 6.000 ms: status=${resAfterIdle.status}, data=`, dataAfterIdle);

    const passIdle = resAfterIdle.status === 201 && closedCount > 0 && idleActualMs >= 6000;
    console.log(`[Idle 6s] Tiêu chí: Đóng socket cũ sau 5s, chờ đủ 6000ms, thanh toán mới thành công 201 -> ${passIdle ? 'PASS' : 'FAIL'}`);

    report.rà_soát_nhàn_rỗi_6s = {
      actualWaitMs: idleActualMs,
      closedSocketsCount: closedCount,
      paymentStatus: resAfterIdle.status,
      passed: passIdle,
    };

    // -------------------------------------------------------------------
    // HỒI QUY: GIAI ĐOẠN 1 & 2
    // -------------------------------------------------------------------
    console.log('\n>>> KIỂM TRA HỒI QUY GIAI ĐOẠN 1 & 2 <<<');
    stopBank();
    stopFee();
    await sleep(500);

    await startBank({ DELAY_MS: '0' });
    await startFee();
    await sleep(500);

    const p1Proc = spawn('node', ['test-phase1.js'], { cwd: __dirname, stdio: 'pipe' });
    let p1Out = '';
    p1Proc.stdout.on('data', (d) => { p1Out += d.toString(); });
    p1Proc.stderr.on('data', (d) => { p1Out += d.toString(); });
    await new Promise((resolve) => p1Proc.on('close', resolve));
    const p1Pass = p1Out.includes('11/11 TESTS THÀNH CÔNG');
    console.log(`Hồi quy Giai đoạn 1: ${p1Pass ? 'PASS (11/11)' : 'FAIL'}`);

    // Hồi quy 20 thanh toán khi DELAY_MS=5000
    stopBank();
    stopFee();
    await sleep(500);
    await startBank({ DELAY_MS: '5000' });
    await startFee();
    await sleep(500);

    console.log('Chạy 20 thanh toán khi DELAY_MS=5000...');
    const d5Promises = [];
    for (let i = 0; i < 20; i++) {
      const p = (async () => {
        const t0 = performance.now();
        const r = await fetch(`${FEE_URL}/students/1/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: 1000 }),
        });
        const d = Math.round(performance.now() - t0);
        const j = await r.json();
        return { status: r.status, duration: d, data: j };
      })();
      d5Promises.push(p);
    }
    const d5Results = await Promise.all(d5Promises);
    const all504 = d5Results.every(r => r.status === 504 && r.data.status === 'PENDING');
    const allUnder4500 = d5Results.every(r => r.duration <= 4500);
    const maxD5 = Math.max(...d5Results.map(r => r.duration));
    console.log(`20 thanh toán khi DELAY_MS=5000: all504=${all504}, allUnder4500=${allUnder4500}, maxDuration=${maxD5} ms`);

    const p2Pass = all504 && allUnder4500;
    console.log(`Hồi quy Giai đoạn 2: ${p2Pass ? 'PASS' : 'FAIL'}`);

    report.hồi_quy = {
      phase1Passed: p1Pass,
      phase2Passed: p2Pass,
      maxD5Duration: maxD5,
    };

    console.log('\n====================================================');
    console.log('HOÀN THÀNH TẤT CẢ KIỂM THỬ GIAI ĐOẠN 4');
    console.log('====================================================');
  } catch (err) {
    console.error('Lỗi khi chạy kiểm thử Giai đoạn 4:', err);
  } finally {
    stopBank();
    stopFee();
  }

  return report;
}

runPhase4Tests().then((res) => {
  console.log('\n[SUMMARY JSON FOR RESULTS_PHASE4.md]');
  console.log(JSON.stringify(res, null, 2));
});
