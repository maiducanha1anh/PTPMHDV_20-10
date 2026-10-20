/**
 * Script đo Baseline cho Giai đoạn 3 (Trước khi bật keep-alive)
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

function startBank() {
  return new Promise((resolve) => {
    bankProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, 'bank-service'),
      env: { ...process.env, DELAY_MS: '0', FAIL_RATE: '0', DROP_RATE: '0' },
      stdio: 'pipe',
    });
    bankProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Bank Service is listening')) resolve();
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

function startFee() {
  return new Promise((resolve) => {
    feeProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, 'fee-service'),
      env: { ...process.env, BANK_URL: 'http://localhost:4002' },
      stdio: 'pipe',
    });
    feeProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Fee Service is listening')) resolve();
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

async function runBaseline() {
  console.log('====================================================');
  console.log('BẮT ĐẦU ĐO BASELINE GIAI ĐOẠN 3 (KEEP-ALIVE: FALSE)');
  console.log('====================================================\n');

  try {
    stopBank();
    stopFee();
    await sleep(500);

    await startBank();
    await startFee();
    await sleep(500);

    // 1. Lấy stats ban đầu
    const statsBefore = await (await fetch(`${BANK_URL}/stats`)).json();
    console.log('Stats trước khi chạy 200 thanh toán:', statsBefore);

    const initialFee = await (await fetch(`${FEE_URL}/students/1/fees`)).json();
    console.log('Công nợ sinh viên 1 ban đầu:', initialFee);

    // 2. Chạy 200 thanh toán với 10 worker
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

    console.log(`Bắt đầu gửi ${TOTAL_PAYMENTS} thanh toán với ${NUM_WORKERS} workers đồng thời...`);
    const startTime = performance.now();
    await Promise.all(Array.from({ length: NUM_WORKERS }, (_, i) => worker(i + 1)));
    const totalDuration = Math.round(performance.now() - startTime);

    console.log(`\nHoàn thành 200 thanh toán trong: ${totalDuration} ms`);
    console.log(`Thành công: ${successCount}, Thất bại: ${failCount}`);

    // 3. Lấy stats sau khi chạy
    const statsAfter = await (await fetch(`${BANK_URL}/stats`)).json();
    console.log('Stats sau khi chạy 200 thanh toán:', statsAfter);

    const finalFee = await (await fetch(`${FEE_URL}/students/1/fees`)).json();
    console.log('Công nợ sinh viên 1 sau cùng:', finalFee);

    const deltaConnections = statsAfter.connections - statsBefore.connections;
    const deltaCharges = statsAfter.charges - statsBefore.charges;
    const deltaRequests = statsAfter.requests - statsBefore.requests;

    console.log('\n--- KẾT QUẢ BASELINE ---');
    console.log(`Tổng thời gian: ${totalDuration} ms`);
    console.log(`Số yêu cầu thành công: ${successCount} / ${TOTAL_PAYMENTS}`);
    console.log(`Chênh lệch TCP connections: ${deltaConnections}`);
    console.log(`Chênh lệch requests ngân hàng: ${deltaRequests}`);
    console.log(`Chênh lệch charges: ${deltaCharges}`);
    console.log(`Duplicates: ${statsAfter.duplicates}`);
    console.log(`Giảm công nợ: ${initialFee.debt - finalFee.debt} đồng (từ ${initialFee.debt} xuống ${finalFee.debt})`);
  } catch (err) {
    console.error('Lỗi khi chạy baseline:', err);
  } finally {
    stopBank();
    stopFee();
  }
}

runBaseline();
