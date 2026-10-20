/**
 * Script đo hiện trạng (Baseline) trước khi sửa code
 */
async function measureBaseline() {
  console.log('--- ĐO BASELINE KHI NGÂN HÀNG TẮT ---');
  const startT1 = performance.now();
  try {
    const res1 = await fetch('http://localhost:4001/students/1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000 }),
    });
    const dur1 = Math.round(performance.now() - startT1);
    const data1 = await res1.json();
    console.log(`Status: ${res1.status}, Duration: ${dur1} ms`);
    console.log('Response body:', data1);

    const startFees = performance.now();
    const resFees = await fetch('http://localhost:4001/students/1/fees');
    const durFees = Math.round(performance.now() - startFees);
    const dataFees = await resFees.json();
    console.log(`GET /fees Status: ${resFees.status}, Duration: ${durFees} ms, Data:`, dataFees);
  } catch (err) {
    console.error('Lỗi khi gọi Fee Service:', err);
  }
}

measureBaseline();
