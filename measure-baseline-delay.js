/**
 * Script đo hiện trạng (Baseline) khi ngân hàng DELAY_MS=5000
 */
async function measureBaselineDelay() {
  console.log('--- ĐO BASELINE KHI NGÂN HÀNG DELAY_MS=5000 ---');
  const startT = performance.now();
  try {
    const res = await fetch('http://localhost:4001/students/1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000 }),
    });
    const dur = Math.round(performance.now() - startT);
    const data = await res.json();
    console.log(`Status: ${res.status}, Duration: ${dur} ms`);
    console.log('Response body:', data);
  } catch (err) {
    const dur = Math.round(performance.now() - startT);
    console.error(`Lỗi sau ${dur} ms:`, err);
  }
}

measureBaselineDelay();
