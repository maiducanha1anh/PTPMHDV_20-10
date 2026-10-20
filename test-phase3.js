/**
 * Script kiểm thử tự động Giai đoạn 3: Tái sử dụng kết nối TCP (Keep-Alive Pool)
 */
const { spawn } = require('child_process');
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

async function runPhase3Tests() {
  console.log('====================================================');
  console.log('BẮT ĐẦU KIỂM THỬ GIAI ĐOẠN 3 (TCP KEEP-ALIVE POOL)');
  console.log('====================================================\n');

  const summary = {};

  try {
    // -------------------------------------------------------------------
    // PHẦN 1: 200 THANH TOÁN VỚI 10 WORKERS ĐỒNG THỜI (DỮ LIỆU SẠCH)
    // -------------------------------------------------------------------
    console.log('>>> PHẦN 1: Kiểm thử 200 thanh toán với 10 worker đồng thời <<<');
    stopBank();
    stopFee();
    await sleep(500);

    await startBank();
    await startFee();
    await sleep(500);

    // Đo stats trước khi gửi 200 thanh toán
    const statsBefore = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeBefore = await (await fetch(`${FEE_URL}/students/1/fees`)).json();
    console.log(`[Setup] Stats ban đầu: connections=${statsBefore.connections}, requests=${statsBefore.requests}, charges=${statsBefore.charges}`);
    console.log(`[Setup] Công nợ ban đầu: ${feeBefore.debt}đ`);

    const TOTAL_PAYMENTS = 200;
    const NUM_WORKERS = 10;
    let taskIndex = 0;
    let successCount = 0;
    let failCount = 0;

    async function worker(id) {
      while (true) {
        let currentTask;
        if (taskIndex < TOTAL_PAYMENTS) {
          currentTask = ++taskIndex;
        } else {
          break;
        }

        try {
          const res = await fetch(`${FEE_URL}/students/1/payments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 1000 }),
          });
          const data = await res.json();
          if (res.status === 201 && data.status === 'PAID') {
            successCount++;
          } else {
            failCount++;
            console.error(`Worker ${id} Task ${currentTask} failed:`, res.status, data);
          }
        } catch (err) {
          failCount++;
          console.error(`Worker ${id} Task ${currentTask} error:`, err.message);
        }
      }
    }

    console.log(`Gửi ${TOTAL_PAYMENTS} thanh toán bằng ${NUM_WORKERS} workers...`);
    const startTime200 = performance.now();
    await Promise.all(Array.from({ length: NUM_WORKERS }, (_, i) => worker(i + 1)));
    const duration200 = Math.round(performance.now() - startTime200);

    // Đo stats ngay sau khi 200 thanh toán hoàn tất
    const statsAfter200 = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeAfter200 = await (await fetch(`${FEE_URL}/students/1/fees`)).json();

    const deltaConn200 = statsAfter200.connections - statsBefore.connections;
    const deltaCharges200 = statsAfter200.charges - statsBefore.charges;

    console.log(`\nKết quả lượt 200 thanh toán:`);
    console.log(`- Thời gian tổng: ${duration200} ms`);
    console.log(`- Số thanh toán thành công: ${successCount} / ${TOTAL_PAYMENTS}`);
    console.log(`- Chênh lệch TCP connections: ${deltaConn200} (Yêu cầu: <= 20)`);
    console.log(`- Chênh lệch charges: ${deltaCharges200} (Yêu cầu: tăng 200)`);
    console.log(`- Duplicates: ${statsAfter200.duplicates} (Yêu cầu: 0)`);
    console.log(`- Công nợ sinh viên 1: ${feeAfter200.debt}đ (Yêu cầu: giảm 200.000đ còn 49.800.000đ)`);

    const p1_allPaid = successCount === 200 && failCount === 0;
    const p1_connUnder20 = deltaConn200 <= 20;
    const p1_charges200 = deltaCharges200 === 200 && statsAfter200.duplicates === 0;
    const p1_debtCorrect = feeAfter200.debt === 49800000;

    console.log(`[P1.1] Tiêu chí 200/200 trả 201 PAID -> ${p1_allPaid ? 'PASS' : 'FAIL'}`);
    console.log(`[P1.2] Tiêu chí số kết nối TCP <= 20 -> ${p1_connUnder20 ? 'PASS' : 'FAIL'}`);
    console.log(`[P1.3] Tiêu chí charges tăng 200, duplicates = 0 -> ${p1_charges200 ? 'PASS' : 'FAIL'}`);
    console.log(`[P1.4] Tiêu chí công nợ còn đúng 49.800.000đ -> ${p1_debtCorrect ? 'PASS' : 'FAIL'}`);

    summary.part1 = {
      duration200,
      successCount,
      deltaConn200,
      deltaCharges200,
      duplicates: statsAfter200.duplicates,
      finalDebt: feeAfter200.debt,
      passed: p1_allPaid && p1_connUnder20 && p1_charges200 && p1_debtCorrect,
    };

    // -------------------------------------------------------------------
    // PHẦN 2: 6 GIÂY NHÀN RỖI VÀ 5 THANH TOÁN TIẾP THEO
    // -------------------------------------------------------------------
    console.log('\n>>> PHẦN 2: Nhàn rỗi 6.5 giây và gửi thêm 5 thanh toán <<<');
    console.log('Đang chờ 6.5 giây (HOÀN TOÀN KHÔNG GỌI /stats HOẶC GỬI REQUEST)...');

    const logsBeforeIdleCount = bankLogs.join('').split('[BANK] [TCP] Socket closed').length - 1;

    // Chờ 6.5s để ngân hàng đóng các kết nối nhàn rỗi (keepAliveTimeout = 5000)
    await sleep(6500);

    const fullLogsAfterIdle = bankLogs.join('');
    const logsAfterIdleCount = fullLogsAfterIdle.split('[BANK] [TCP] Socket closed').length - 1;
    const closedSocketsDuringIdle = logsAfterIdleCount - logsBeforeIdleCount;

    console.log(`Xác nhận từ log ngân hàng: Có ${closedSocketsDuringIdle} socket đã kích hoạt sự kiện close trong thời gian nhàn rỗi.`);

    // Gửi tiếp 5 thanh toán (mỗi lần 1.000đ)
    console.log('Gửi 5 thanh toán tiếp theo...');
    let idleSuccessCount = 0;
    for (let i = 1; i <= 5; i++) {
      const resIdle = await fetch(`${FEE_URL}/students/1/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1000 }),
      });
      const dataIdle = await resIdle.json();
      if (resIdle.status === 201 && dataIdle.status === 'PAID') {
        idleSuccessCount++;
      } else {
        console.error(`Thanh toán ${i} sau nhàn rỗi thất bại:`, resIdle.status, dataIdle);
      }
    }

    // Lấy stats sau 5 thanh toán
    const statsAfterIdle5 = await (await fetch(`${BANK_URL}/stats`)).json();
    const feeAfterIdle5 = await (await fetch(`${FEE_URL}/students/1/fees`)).json();

    const newConnectionsAfterIdle = statsAfterIdle5.connections - statsAfter200.connections;
    console.log(`\nKết quả sau 6 giây nhàn rỗi:`);
    console.log(`- Số thanh toán thành công: ${idleSuccessCount} / 5`);
    console.log(`- Số kết nối TCP mới mở thêm sau nhàn rỗi: ${newConnectionsAfterIdle}`);
    console.log(`- Công nợ sinh viên 1 hiện tại: ${feeAfterIdle5.debt}đ (Yêu cầu: 49.795.000đ)`);

    const p2_5success = idleSuccessCount === 5;
    const p2_newSocketsOpened = newConnectionsAfterIdle > 0;
    const p2_socketsClosedVerified = closedSocketsDuringIdle > 0;
    const p2_debtCorrect = feeAfterIdle5.debt === 49795000;

    console.log(`[P2.1] Tiêu chí 5/5 thanh toán thành công sau nhàn rỗi -> ${p2_5success ? 'PASS' : 'FAIL'}`);
    console.log(`[P2.2] Xác nhận kết nối cũ đã đóng từ log server -> ${p2_socketsClosedVerified ? 'PASS' : 'FAIL'}`);
    console.log(`[P2.3] Xác nhận hệ thống tạo kết nối mới khi cần -> ${p2_newSocketsOpened ? 'PASS' : 'FAIL'}`);
    console.log(`[P2.4] Tiêu chí công nợ còn đúng 49.795.000đ -> ${p2_debtCorrect ? 'PASS' : 'FAIL'}`);

    summary.part2 = {
      idleSuccessCount,
      closedSocketsDuringIdle,
      newConnectionsAfterIdle,
      finalDebt: feeAfterIdle5.debt,
      passed: p2_5success && p2_socketsClosedVerified && p2_newSocketsOpened && p2_debtCorrect,
    };

    // -------------------------------------------------------------------
    // PHẦN 3: KIỂM TRA HỒI QUY (REGRESSION TESTS)
    // -------------------------------------------------------------------
    console.log('\n>>> PHẦN 3: Kiểm tra hồi quy Giai đoạn 1 & Giai đoạn 2 <<<');

    // 3.1 Hồi quy Giai đoạn 1
    console.log('[3.1] Chạy hồi quy Giai đoạn 1 (test-phase1.js)...');
    stopBank();
    stopFee();
    await sleep(500);
    await startBank();
    await startFee();
    await sleep(500);

    const p1Proc = spawn('node', ['test-phase1.js'], { cwd: __dirname, stdio: 'pipe' });
    let p1Out = '';
    p1Proc.stdout.on('data', (d) => { p1Out += d.toString(); });
    p1Proc.stderr.on('data', (d) => { p1Out += d.toString(); });
    await new Promise((resolve) => p1Proc.on('close', resolve));
    const p1Passed = p1Out.includes('11/11 TESTS THÀNH CÔNG');
    console.log(`Kết quả hồi quy Giai đoạn 1: ${p1Passed ? 'PASS (11/11)' : 'FAIL'}`);

    // 3.2 Hồi quy Giai đoạn 2 (Đặc biệt 20 request đồng thời khi ngân hàng chậm DELAY_MS=5000)
    console.log('\n[3.2] Chạy hồi quy 20 thanh toán đồng thời khi DELAY_MS=5000 (socket queuing in pool)...');
    stopBank();
    stopFee();
    await sleep(500);
    await startBank({ DELAY_MS: '5000' });
    await startFee();
    await sleep(500);

    const concurrentPayments = [];
    const concurrentDurations = [];
    const concurrentStart = performance.now();

    for (let i = 0; i < 20; i++) {
      const p = (async () => {
        const t0 = performance.now();
        const res = await fetch(`${FEE_URL}/students/1/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: 1000 }),
        });
        const dur = Math.round(performance.now() - t0);
        const data = await res.json();
        concurrentDurations.push(dur);
        return { status: res.status, data, dur };
      })();
      concurrentPayments.push(p);
    }

    // Trong lúc 20 request đang chờ trong pool/ngân hàng, gọi GET /fees
    await sleep(1000);
    const tFeesStart = performance.now();
    const resFees = await fetch(`${FEE_URL}/students/1/fees`);
    const durFees = Math.round(performance.now() - tFeesStart);
    const dataFees = await resFees.json();
    console.log(`GET /fees trong lúc 20 request đang chờ: status=${resFees.status}, duration=${durFees} ms, debt=${dataFees.debt}`);

    const concurrentResults = await Promise.all(concurrentPayments);
    const totalConcurrentTime = Math.round(performance.now() - concurrentStart);

    const all504 = concurrentResults.every((r) => r.status === 504 && r.data.status === 'PENDING');
    const allUnder4500 = concurrentDurations.every((d) => d <= 4500);
    const minDur = Math.min(...concurrentDurations);
    const maxDur = Math.max(...concurrentDurations);
    const avgDur = Math.round(concurrentDurations.reduce((a, b) => a + b, 0) / concurrentDurations.length);

    console.log(`20 requests đồng thời hoàn tất: all504=${all504}, Min=${minDur} ms, Max=${maxDur} ms, Avg=${avgDur} ms`);
    console.log(`GET /fees phản hồi < 300ms: ${durFees < 300 ? 'PASS' : 'FAIL'} (${durFees} ms)`);
    console.log(`Tất cả 20 requests <= 4500ms (bao gồm cả chờ lấy socket): ${allUnder4500 ? 'PASS' : 'FAIL'}`);

    const p2Passed = all504 && allUnder4500 && durFees < 300;
    console.log(`Kết quả hồi quy Giai đoạn 2: ${p2Passed ? 'PASS' : 'FAIL'}`);

    summary.regression = {
      phase1Passed: p1Passed,
      phase2Passed: p2Passed,
      minDur,
      maxDur,
      avgDur,
      durFees,
    };

    console.log('\n====================================================');
    console.log('HOÀN THÀNH TẤT CẢ KIỂM THỬ GIAI ĐOẠN 3');
    console.log('====================================================');
  } catch (err) {
    console.error('Lỗi khi chạy kiểm thử Giai đoạn 3:', err);
  } finally {
    stopBank();
    stopFee();
  }

  return summary;
}

runPhase3Tests().then((res) => {
  console.log('\n[SUMMARY JSON FOR RESULTS_PHASE3.md]');
  console.log(JSON.stringify(res, null, 2));
});
