/**
 * Kịch bản kiểm thử tự động Giai đoạn 1
 * Kiểm tra đầy đủ 6 yêu cầu trong đề bài
 */

async function runTests() {
  const FEE_URL = 'http://localhost:4001';
  const BANK_URL = 'http://localhost:4002';

  console.log('====================================================');
  console.log('BẮT ĐẦU KIỂM THỬ GIAI ĐOẠN 1');
  console.log('====================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      console.log(`[PASS] ${message}`);
      passedTests++;
    } else {
      console.error(`[FAIL] ${message}`);
    }
  }

  try {
    // 1. Xem công nợ sinh viên 1 bằng 50.000.000
    console.log('--- Test 1: Xem công nợ sinh viên 1 ---');
    const res1 = await fetch(`${FEE_URL}/students/1/fees`);
    const data1 = await res1.json();
    console.log('Response:', res1.status, data1);
    assert(res1.status === 200 && data1.debt === 50000000, 'Sinh viên 1 có công nợ ban đầu 50.000.000đ');

    // 2. Thanh toán 100.000 thành công, công nợ còn 49.900.000
    console.log('\n--- Test 2: Thanh toán 100.000 cho sinh viên 1 ---');
    const res2 = await fetch(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000 }),
    });
    const data2 = await res2.json();
    console.log('Response:', res2.status, data2);
    assert(
      res2.status === 201 &&
        data2.status === 'PAID' &&
        data2.amount === 100000 &&
        data2.remainingDebt === 49900000 &&
        data2.chargeId &&
        data2.paymentId === 'P1',
      'Thanh toán 100.000 thành công, trả về HTTP 201 PAID, remainingDebt = 49.900.000đ'
    );

    // Kiểm tra lại bằng GET /students/1/fees
    const res2Check = await fetch(`${FEE_URL}/students/1/fees`);
    const data2Check = await res2Check.json();
    assert(data2Check.debt === 49900000, 'GET /students/1/fees xác nhận công nợ còn đúng 49.900.000đ');

    // 3. Sinh viên 2 không được thanh toán khi công nợ bằng 0
    console.log('\n--- Test 3: Sinh viên 2 có nợ = 0 thanh toán 100.000 ---');
    const res3 = await fetch(`${FEE_URL}/students/2/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000 }),
    });
    const data3 = await res3.json();
    console.log('Response:', res3.status, data3);
    assert(
      res3.status === 400 && data3.status === 'FAILED',
      'Sinh viên 2 bị từ chối với HTTP 400 khi công nợ bằng 0'
    );

    // 4. Thanh toán 25.000.000 cho sinh viên 1 bị ngân hàng từ chối với 402, công nợ không đổi
    console.log('\n--- Test 4: Thanh toán 25.000.000 cho sinh viên 1 (vượt hạn mức 20M của ngân hàng) ---');
    const res4 = await fetch(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 25000000 }),
    });
    const data4 = await res4.json();
    console.log('Response:', res4.status, data4);
    assert(
      res4.status === 402 && data4.status === 'FAILED',
      'Ngân hàng từ chối thanh toán 25.000.000đ với HTTP 402 FAILED'
    );

    // Kiểm tra lại công nợ sinh viên 1 không đổi
    const res4Check = await fetch(`${FEE_URL}/students/1/fees`);
    const data4Check = await res4Check.json();
    assert(data4Check.debt === 49900000, 'Công nợ sinh viên 1 vẫn giữ nguyên 49.900.000đ sau khi bị từ chối');

    // 5. Gửi trực tiếp hai yêu cầu ngân hàng có cùng khóa và dữ liệu: cùng chargeId, chỉ tăng charges một lần
    console.log('\n--- Test 5: Gửi trực tiếp 2 yêu cầu đến ngân hàng cùng Idempotency-Key tuần tự ---');
    const idempKey = 'TEST_IDEMP_SEQ_123';
    const payload = { reference: 'REF_TEST_SEQ_1', amount: 50000 };

    const bankRes5A = await fetch(`${BANK_URL}/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempKey },
      body: JSON.stringify(payload),
    });
    const bankData5A = await bankRes5A.json();
    console.log('Yêu cầu 1:', bankRes5A.status, bankData5A);

    const bankRes5B = await fetch(`${BANK_URL}/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempKey },
      body: JSON.stringify(payload),
    });
    const bankData5B = await bankRes5B.json();
    console.log('Yêu cầu 2:', bankRes5B.status, bankData5B);

    assert(
      bankRes5A.status === 201 &&
        bankRes5B.status === 201 &&
        bankData5A.chargeId === bankData5B.chargeId,
      'Cả hai yêu cầu cùng trả về HTTP 201 và cùng chargeId'
    );

    // 6. Gửi đồng thời cùng khóa vẫn không thu trùng
    console.log('\n--- Test 6: Gửi ĐỒNG THỜI nhiều yêu cầu đến ngân hàng cùng Idempotency-Key ---');
    const concurrentKey = 'TEST_IDEMP_CONCURRENT_999';
    const concurrentPayload = { reference: 'REF_CONCURRENT_1', amount: 200000 };

    const statsBefore = await (await fetch(`${BANK_URL}/stats`)).json();

    const [cRes1, cRes2, cRes3] = await Promise.all([
      fetch(`${BANK_URL}/charges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': concurrentKey },
        body: JSON.stringify(concurrentPayload),
      }),
      fetch(`${BANK_URL}/charges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': concurrentKey },
        body: JSON.stringify(concurrentPayload),
      }),
      fetch(`${BANK_URL}/charges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': concurrentKey },
        body: JSON.stringify(concurrentPayload),
      }),
    ]);

    const cData1 = await cRes1.json();
    const cData2 = await cRes2.json();
    const cData3 = await cRes3.json();

    console.log('Kết quả 3 requests đồng thời:', [cData1.chargeId, cData2.chargeId, cData3.chargeId]);

    const statsAfter = await (await fetch(`${BANK_URL}/stats`)).json();
    console.log('Stats trước Test 6:', statsBefore);
    console.log('Stats sau Test 6:', statsAfter);

    assert(
      cRes1.status === 201 &&
        cRes2.status === 201 &&
        cRes3.status === 201 &&
        cData1.chargeId === cData2.chargeId &&
        cData2.chargeId === cData3.chargeId,
      'Cả 3 request đồng thời đều nhận cùng một chargeId'
    );

    assert(
      statsAfter.charges === statsBefore.charges + 1 && statsAfter.duplicates === 0,
      'Số lần thu tiền thực tế (charges) chỉ tăng 1, duplicates = 0'
    );

    // 7. Kiểm soát thanh toán đồng thời phía Fee Service (không cho phép tổng tiền vượt công nợ khả dụng)
    console.log('\n--- Test 7: Kiểm soát thanh toán đồng thời phía Fee Service ---');
    // Sinh viên 3 có nợ 3.200.000đ. Gửi đồng thời 2 yêu cầu: mỗi yêu cầu 2.000.000đ (tổng 4M > 3.2M)
    const [feeConcurrent1, feeConcurrent2] = await Promise.all([
      fetch(`${FEE_URL}/students/3/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 2000000 }),
      }),
      fetch(`${FEE_URL}/students/3/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 2000000 }),
      }),
    ]);

    const fcData1 = await feeConcurrent1.json();
    const fcData2 = await feeConcurrent2.json();
    console.log('Fee concurrency 1:', feeConcurrent1.status, fcData1);
    console.log('Fee concurrency 2:', feeConcurrent2.status, fcData2);

    const oneSucceeded = (feeConcurrent1.status === 201 && feeConcurrent2.status === 400) ||
                         (feeConcurrent1.status === 400 && feeConcurrent2.status === 201);
    assert(oneSucceeded, 'Chỉ 1 trong 2 yêu cầu đồng thời thành công, yêu cầu còn lại bị từ chối 400 vì vượt công nợ khả dụng');

    const res3Check = await (await fetch(`${FEE_URL}/students/3/fees`)).json();
    assert(res3Check.debt === 1200000, 'Công nợ còn lại của sinh viên 3 đúng bằng 1.200.000đ');

    console.log('\n====================================================');
    console.log(`KẾT QUẢ: ${passedTests}/${totalTests} TESTS THÀNH CÔNG!`);
    console.log('====================================================\n');
  } catch (error) {
    console.error('Lỗi khi chạy test:', error);
  }
}

runTests();
