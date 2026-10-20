/**
 * Script kiểm thử tự động Giai đoạn 2 (Tình huống 1 & 2)
 */
const { spawn } = require('child_process');
const path = require('path');

const FEE_URL = 'http://localhost:4001';
const BANK_URL = 'http://localhost:4002';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Quản lý các tiến trình con do script tạo ra
let bankProcess = null;
let feeProcess = null;

function startBank(envVars = {}) {
  return new Promise((resolve) => {
    bankProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, 'bank-service'),
      env: { ...process.env, ...envVars },
      stdio: 'pipe',
    });

    bankProcess.stdout.on('data', (d) => {
      // console.log(`[BANK OUT] ${d}`);
      if (d.toString().includes('Bank Service is listening')) {
        resolve();
      }
    });

    // Fallback nếu không bắt được log
    setTimeout(resolve, 1500);
  });
}

function stopBank() {
  if (bankProcess) {
    try {
      bankProcess.kill('SIGKILL');
    } catch (e) {}
    bankProcess = null;
  }
}

function startFee(envVars = {}) {
  return new Promise((resolve) => {
    feeProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, 'fee-service'),
      env: { ...process.env, ...envVars },
      stdio: 'pipe',
    });

    feeProcess.stdout.on('data', (d) => {
      // console.log(`[FEE OUT] ${d}`);
      if (d.toString().includes('Fee Service is listening')) {
        resolve();
      }
    });

    // Fallback nếu không bắt được log
    setTimeout(resolve, 1500);
  });
}

function stopFee() {
  if (feeProcess) {
    try {
      feeProcess.kill('SIGKILL');
    } catch (e) {}
    feeProcess = null;
  }
}

async function runPhase2Tests() {
  console.log('====================================================');
  console.log('BẮT ĐẦU KIỂM THỬ GIAI ĐOẠN 2');
  console.log('====================================================\n');

  const testResults = {
    situation1: {},
    situation2Single: {},
    situation2Concurrent: {},
    regression: {},
  };

  try {
    // ---------------------------------------------------------
    // TÌNH HUỐNG 1: NGÂN HÀNG KHÔNG KẾT NỐI ĐƯỢC RỒI HOẠT ĐỘNG LẠI
    // ---------------------------------------------------------
    console.log('>>> BẮT ĐẦU TÌNH HUỐNG 1: Ngân hàng không kết nối được <<<');

    // Đảm bảo ngân hàng TẮT, chỉ khởi động Fee Service
    stopBank();
    stopFee();
    await sleep(500);
    await startFee();
    console.log('[Setup] Fee Service đang chạy, Bank Service ĐANG TẮT.');

    // 1.1 Gọi thanh toán khi ngân hàng tắt
    const t1Start = performance.now();
    const res1 = await fetch(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000 }),
    });
    const t1Duration = Math.round(performance.now() - t1Start);
    const data1 = await res1.json();

    console.log(`[1.1] Kết quả thanh toán khi ngân hàng tắt:`);
    console.log(`      Status: ${res1.status}, Duration: ${t1Duration} ms`);
    console.log(`      Body:`, data1);

    const s1_passed =
      res1.status === 503 &&
      data1.status === 'FAILED' &&
      data1.error &&
      data1.paymentId &&
      t1Duration < 1500;
    console.log(`[1.1] Tiêu chí: 503, FAILED, có error & paymentId, thời gian < 1500ms -> ${s1_passed ? 'PASS' : 'FAIL'}`);

    // 1.2 Kiểm tra Fee Service không sập và GET /fees vẫn trả 200 nhanh
    const tFeesStart = performance.now();
    const resFees = await fetch(`${FEE_URL}/students/1/fees`);
    const tFeesDuration = Math.round(performance.now() - tFeesStart);
    const dataFees = await resFees.json();

    console.log(`[1.2] Kiểm tra GET /students/1/fees:`);
    console.log(`      Status: ${resFees.status}, Duration: ${tFeesDuration} ms, Debt: ${dataFees.debt}`);
    const s1_fees_passed = resFees.status === 200 && dataFees.debt === 50000000 && tFeesDuration < 300;
    console.log(`[1.2] Tiêu chí: HTTP 200, thời gian < 300ms, không sập -> ${s1_fees_passed ? 'PASS' : 'FAIL'}`);

    // 1.3 Bật lại Ngân hàng (KHÔNG KHỞI ĐỘNG LẠI FEE SERVICE)
    console.log('[Setup] Đang khởi động Bank Service (giữ nguyên Fee Service)...');
    await startBank({ DELAY_MS: '0' });
    await sleep(500);

    const tReplayStart = performance.now();
    const resReplay = await fetch(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000 }),
    });
    const tReplayDuration = Math.round(performance.now() - tReplayStart);
    const dataReplay = await resReplay.json();

    console.log(`[1.3] Kết quả thanh toán sau khi ngân hàng bật lại:`);
    console.log(`      Status: ${resReplay.status}, Duration: ${tReplayDuration} ms`);
    console.log(`      Body:`, dataReplay);
    const s1_replay_passed =
      resReplay.status === 201 &&
      dataReplay.status === 'PAID' &&
      dataReplay.remainingDebt === 49900000;
    console.log(`[1.3] Tiêu chí: HTTP 201 PAID, công nợ giảm còn 49.900.000đ -> ${s1_replay_passed ? 'PASS' : 'FAIL'}`);

    // 1.4 Kiểm tra với BANK_URL=http://localhost:4999 (cổng không có dịch vụ)
    console.log('[1.4] Kiểm tra với BANK_URL=http://localhost:4999:');
    const BankClient = require('./fee-service/bank-client');
    const dummyClient = new BankClient('http://localhost:4999');
    const t4999Start = performance.now();
    const res4999 = await dummyClient.charge({ reference: 'TEST_4999', amount: 100000, idempotencyKey: 'K4999' });
    const t4999Duration = Math.round(performance.now() - t4999Start);
    console.log(`      Kết quả: statusCode=${res4999.statusCode}, type=${res4999.type}, duration=${t4999Duration} ms`);
    const s1_4999_passed = res4999.statusCode === 503 && res4999.type === 'CONNECTION_REFUSED' && t4999Duration < 1500;
    console.log(`[1.4] Tiêu chí: 503 CONNECTION_REFUSED, thời gian < 1500ms -> ${s1_4999_passed ? 'PASS' : 'FAIL'}`);

    testResults.situation1 = {
      bankOffDuration: t1Duration,
      bankOffStatus: res1.status,
      feeCheckDuration: tFeesDuration,
      replayDuration: tReplayDuration,
      replayStatus: resReplay.status,
      port4999Duration: t4999Duration,
      port4999Status: res4999.statusCode,
    };

    // ---------------------------------------------------------
    // TÌNH HUỐNG 2: NGÂN HÀNG PHẢN HỒI RẤT CHẬM (DELAY_MS=5000)
    // ---------------------------------------------------------
    console.log('\n>>> BẮT ĐẦU TÌNH HUỐNG 2: Ngân hàng phản hồi chậm (DELAY_MS=5000) <<<');
    stopBank();
    stopFee();
    await sleep(500);

    // Khởi động dữ liệu sạch: Ngân hàng có DELAY_MS=5000, Fee Service sạch
    await startBank({ DELAY_MS: '5000' });
    await startFee();
    await sleep(500);
    console.log('[Setup] Bank Service DELAY_MS=5000, Fee Service sạch sẵn sàng.');

    // 2.1 Đo 1 thanh toán đơn lẻ
    const tSingleStart = performance.now();
    const resSingle = await fetch(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000 }),
    });
    const tSingleDuration = Math.round(performance.now() - tSingleStart);
    const dataSingle = await resSingle.json();

    console.log(`[2.1] Kết quả thanh toán đơn lẻ khi DELAY_MS=5000:`);
    console.log(`      Status: ${resSingle.status}, Duration: ${tSingleDuration} ms`);
    console.log(`      Body:`, dataSingle);

    const s2_single_passed =
      resSingle.status === 504 &&
      dataSingle.status === 'PENDING' &&
      dataSingle.paymentId &&
      tSingleDuration <= 4500;
    console.log(`[2.1] Tiêu chí: 504 PENDING, duration <= 4500ms -> ${s2_single_passed ? 'PASS' : 'FAIL'}`);

    // Kiểm tra công nợ và công nợ khả dụng sau khi nhận 504 PENDING:
    const checkDebtSingle = await (await fetch(`${FEE_URL}/students/1/fees`)).json();
    console.log(`      Công nợ thực tế (debt): ${checkDebtSingle.debt} (mong đợi: 50.000.000 - KHÔNG GIẢM)`);

    // Thử thanh toán 49.950.000đ: khả dụng = 50M - 100K reserved = 49.900.000đ < 49.950.000đ -> phải trả 400
    const resOver = await fetch(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 49950000 }),
    });
    const dataOver = await resOver.json();
    console.log(`      Thử thanh toán vượt công nợ khả dụng: Status=${resOver.status}, Body=`, dataOver);
    const s2_reserved_passed = checkDebtSingle.debt === 50000000 && resOver.status === 400;
    console.log(`[2.1] Tiêu chí quản lý công nợ khả dụng: Giữ nguyên debt, giữ khoản reservedDebt -> ${s2_reserved_passed ? 'PASS' : 'FAIL'}`);

    testResults.situation2Single = {
      duration: tSingleDuration,
      status: resSingle.status,
      bodyStatus: dataSingle.status,
      debtUnchanged: checkDebtSingle.debt === 50000000,
      reservedEnforced: resOver.status === 400,
    };

    // ---------------------------------------------------------
    // KIỂM THỬ ĐỒNG THỜI 20 THANH TOÁN (DELAY_MS=5000)
    // ---------------------------------------------------------
    console.log('\n>>> BẮT ĐẦU KIỂM THỬ ĐỒNG THỜI: 20 thanh toán song song <<<');
    stopBank();
    stopFee();
    await sleep(500);

    await startBank({ DELAY_MS: '5000' });
    await startFee();
    await sleep(500);
    console.log('[Setup] Hệ thống khởi động sạch cho test đồng thời.');

    console.log('Gửi đồng thời 20 yêu cầu thanh toán (mỗi yêu cầu 1.000đ)...');
    const paymentPromises = [];
    const durations = [];

    const batchStart = performance.now();

    for (let i = 0; i < 20; i++) {
      const p = (async (index) => {
        const reqStart = performance.now();
        const res = await fetch(`${FEE_URL}/students/1/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: 1000 }),
        });
        const reqDuration = Math.round(performance.now() - reqStart);
        const data = await res.json();
        durations.push(reqDuration);
        return { index, status: res.status, duration: reqDuration, data };
      })(i);
      paymentPromises.push(p);
    }

    // Đợi 1000ms khi 20 request THỰC SỰ đang chờ, gửi GET /students/1/fees
    await sleep(1000);
    console.log('Đang gửi GET /students/1/fees trong lúc 20 request đang chờ phản hồi từ ngân hàng...');
    const tConcurrentFeesStart = performance.now();
    const resConcurrentFees = await fetch(`${FEE_URL}/students/1/fees`);
    const tConcurrentFeesDuration = Math.round(performance.now() - tConcurrentFeesStart);
    const dataConcurrentFees = await resConcurrentFees.json();

    console.log(`Kết quả GET /students/1/fees trong lúc chờ:`);
    console.log(`Status: ${resConcurrentFees.status}, Duration: ${tConcurrentFeesDuration} ms, Debt: ${dataConcurrentFees.debt}`);
    const get_fees_during_wait_passed =
      resConcurrentFees.status === 200 && tConcurrentFeesDuration < 300;
    console.log(`Tiêu chí: GET /fees phản hồi < 300ms trong lúc ngân hàng chậm -> ${get_fees_during_wait_passed ? 'PASS' : 'FAIL'}`);

    // Chờ toàn bộ 20 payment kết thúc
    const results = await Promise.all(paymentPromises);
    const totalBatchDuration = Math.round(performance.now() - batchStart);

    console.log(`\nToàn bộ 20 requests đã hoàn tất trong tổng thời gian: ${totalBatchDuration} ms`);
    const minDur = Math.min(...durations);
    const maxDur = Math.max(...durations);
    const avgDur = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    console.log(`Thống kê thời gian 20 requests: Min=${minDur} ms, Max=${maxDur} ms, Avg=${avgDur} ms`);

    const all504 = results.every((r) => r.status === 504 && r.data.status === 'PENDING');
    const allUnderLimit = results.every((r) => r.duration <= 4500);

    console.log(`Tiêu chí: 20/20 trả về 504 PENDING -> ${all504 ? 'PASS' : 'FAIL'}`);
    console.log(`Tiêu chí: Tất cả 20 requests thời gian <= 4500 ms -> ${allUnderLimit ? 'PASS' : 'FAIL'}`);

    // Chờ thêm 2 giây để chắc chắn ngân hàng hoàn thành xong trễ 5 giây
    console.log('Đợi thêm 2 giây để ngân hàng kết thúc độ trễ 5.000 ms...');
    await sleep(2000);

    // Kiểm tra không có cập nhật muộn ngoài ý muốn:
    const finalFeeCheck = await (await fetch(`${FEE_URL}/students/1/fees`)).json();
    console.log(`Kiểm tra công nợ sau khi ngân hàng hết delay: Debt=${finalFeeCheck.debt} (mong đợi: 50.000.000)`);
    const no_late_update = finalFeeCheck.debt === 50000000;
    console.log(`Tiêu chí: Không có cập nhật muộn ngoài ý muốn sau khi đã trả PENDING -> ${no_late_update ? 'PASS' : 'FAIL'}`);

    testResults.situation2Concurrent = {
      all504,
      allUnderLimit,
      getFeesDuringWaitDuration: tConcurrentFeesDuration,
      minDuration: minDur,
      maxDuration: maxDur,
      avgDuration: avgDur,
      noLateUpdate: no_late_update,
    };

    // ---------------------------------------------------------
    // HỒI QUY: CHẠY LẠI GIAI ĐOẠN 1
    // ---------------------------------------------------------
    console.log('\n>>> KIỂM TRA HỒI QUY VỚI GIAI ĐOẠN 1 (Ngân hàng bình thường) <<<');
    stopBank();
    stopFee();
    await sleep(500);

    await startBank({ DELAY_MS: '0' });
    await startFee();
    await sleep(500);

    console.log('Chạy test-phase1.js...');
    const p1 = spawn('node', ['test-phase1.js'], { cwd: __dirname, stdio: 'pipe' });
    let p1Output = '';
    p1.stdout.on('data', (d) => { p1Output += d.toString(); });
    p1.stderr.on('data', (d) => { p1Output += d.toString(); });

    await new Promise((resolve) => p1.on('close', resolve));
    const regressionPassed = p1Output.includes('11/11 TESTS THÀNH CÔNG');
    console.log(`Kết quả hồi quy Giai đoạn 1: ${regressionPassed ? 'PASS (11/11)' : 'FAIL'}`);
    testResults.regression = { passed: regressionPassed };

    console.log('\n====================================================');
    console.log('HOÀN THÀNH TẤT CẢ KIỂM THỬ GIAI ĐOẠN 2');
    console.log('====================================================');
  } catch (err) {
    console.error('Lỗi khi chạy kiểm thử Giai đoạn 2:', err);
  } finally {
    stopBank();
    stopFee();
  }

  return testResults;
}

runPhase2Tests().then((res) => {
  console.log('\n[SUMMARY JSON FOR RESULTS_PHASE2.md]');
  console.log(JSON.stringify(res, null, 2));
});
