# LAB 3 — Kết nối và duy trì kết nối giữa các service

Dự án mô phỏng hệ thống thanh toán học phí trực tuyến gồm hai microservice viết bằng **Node.js/Express**, lưu trữ dữ liệu trong bộ nhớ (in-memory):
- **Fee Service (Cổng 4001):** Hệ thống của trường, quản lý công nợ sinh viên, tiếp nhận yêu cầu thanh toán, kiểm soát thanh toán đồng thời và gọi ngân hàng.
- **Bank Service (Cổng 4002):** Cổng thanh toán bên thứ ba giả lập, xử lý trừ tiền với hạn mức tối đa 20.000.000đ, hỗ trợ header `Idempotency-Key` (tính lũy đẳng), đếm kết nối TCP thực tế và mô phỏng các lỗi mạng/chậm trễ.

---

## 1. Cài đặt Dependency và Khởi động

### Cài đặt thư viện:
Mở PowerShell tại thư mục gốc dự án:
```powershell
cd c:\Lab3\bank-service ; npm install
cd c:\Lab3\fee-service  ; npm install
```

### Khởi động bằng 2 Terminal PowerShell:

**Terminal 1 — Bank Service:**
```powershell
cd c:\Lab3\bank-service
npm start
```
*Mặc định lắng nghe tại `http://localhost:4002`.*

**Terminal 2 — Fee Service:**
```powershell
cd c:\Lab3\fee-service
npm start
```
*Mặc định lắng nghe tại `http://localhost:4001`, tự động kết nối tới ngân hàng qua `http://localhost:4002`.*

> **Lưu ý về dữ liệu in-memory:**  
> Toàn bộ dữ liệu (công nợ sinh viên, mã giao dịch, thống kê TCP) được lưu trong bộ nhớ. Mọi thay đổi sẽ mất khi khởi động lại tiến trình. Để bắt đầu lượt kiểm thử sạch, nhấn `Ctrl + C` ở cả hai terminal và chạy lại `npm start`.

---

## 2. Danh sách API chính

### Fee Service (Cổng 4001):
- `GET /students/:id/fees`: Trả về công nợ của sinh viên.
  - Dữ liệu ban đầu: Sinh viên 1: `50.000.000đ`, Sinh viên 2: `0đ`, Sinh viên 3: `3.200.000đ`.
- `POST /students/:id/payments`: Tiếp nhận thanh toán học phí.
  - Body JSON: `{"amount": 100000}`
  - Thành công: HTTP `201 PAID` kèm `paymentId`, `chargeId`, `remainingDebt`.
  - Ngân hàng từ chối: Giữ mã lỗi ngân hàng (ví dụ HTTP `402 FAILED`).
  - Không kết nối được tới ngân hàng: HTTP `503 FAILED`.
  - Hết thời gian chờ hoặc đứt kết nối khi đang chờ: HTTP `504 PENDING`.

### Bank Service (Cổng 4002):
- `POST /charges`: Thu tiền giao dịch.
  - Body JSON: `{"reference": "P1", "amount": 100000}`
  - Header tùy chọn: `Idempotency-Key` (hỗ trợ tính lũy đẳng, chống trừ tiền 2 lần).
  - Trả về: HTTP `201` kèm `chargeId` khi thành công; HTTP `400` nếu sai dữ liệu hoặc tái sử dụng key với dữ liệu khác; HTTP `402` nếu số tiền vượt hạn mức 20.000.000đ.
- `GET /stats`: Thống kê hoạt động của ngân hàng.
  - Trả về JSON: `{"connections": ..., "requests": ..., "charges": ..., "duplicates": ...}`
  - `connections`: Số kết nối TCP mới nhận từ sự kiện socket.
  - `requests`: Số yêu cầu giao dịch `POST /charges` nhận được (bao gồm cả retry).
  - `charges`: Số lần thu tiền thành công thực tế.
  - `duplicates`: Số lần thu tiền trùng cho cùng reference (tính thực tế, luôn bằng 0).

---

## 3. Cấu hình biến môi trường trên Windows PowerShell

### Các biến môi trường:
- `BANK_URL` (Fee Service): Địa chỉ của ngân hàng (mặc định: `http://localhost:4002`).
- `DELAY_MS` (Bank Service): Độ trễ phản hồi thêm (ms), mặc định `0`.
- `FAIL_RATE` (Bank Service): Xác suất (0 đến 1) trả lỗi HTTP 500 trước khi thu tiền, mặc định `0`.
- `DROP_RATE` (Bank Service): Xác suất (0 đến 1) thu tiền xong rồi cắt kết nối trước khi trả lời, mặc định `0`.

### Lệnh chạy mô phỏng các tình huống trên PowerShell:

#### Chạy bình thường (Không lỗi):
```powershell
cd c:\Lab3\bank-service
$env:DELAY_MS="0"; $env:FAIL_RATE="0"; $env:DROP_RATE="0"
npm start
```

#### Mô phỏng ngân hàng trễ 5 giây (Tình huống 2):
```powershell
cd c:\Lab3\bank-service
$env:DELAY_MS="5000"; $env:FAIL_RATE="0"; $env:DROP_RATE="0"
npm start
```

#### Mô phỏng đứt kết nối sau khi thu tiền (Tình huống 4a):
```powershell
cd c:\Lab3\bank-service
$env:DELAY_MS="0"; $env:FAIL_RATE="0"; $env:DROP_RATE="0.3"
npm start
```

#### Mô phỏng lỗi HTTP 500 trước khi thu tiền (Tình huống 4b):
```powershell
cd c:\Lab3\bank-service
$env:DELAY_MS="0"; $env:FAIL_RATE="0.3"; $env:DROP_RATE="0"
npm start
```

#### Xóa / reset biến môi trường về mặc định:
```powershell
Remove-Item Env:DELAY_MS, Env:FAIL_RATE, Env:DROP_RATE -ErrorAction SilentlyContinue
```

---

## 4. Kịch bản kiểm thử tự động

Dự án cung cấp các script kiểm thử tự động độc lập tại thư mục gốc:

- **Kiểm thử Giai đoạn 1 (Cơ bản, Tính lũy đẳng, Concurrency Control):**
  ```powershell
  node test-phase1.js
  ```
- **Kiểm thử Giai đoạn 2 (Tình huống 1: Ngân hàng tắt / Tình huống 2: Ngân hàng trễ 5s):**
  ```powershell
  node test-phase2.js
  ```
- **Kiểm thử Giai đoạn 3 (Tối ưu kết nối TCP Keep-Alive Connection Pool):**
  ```powershell
  node test-phase3.js
  ```
- **Kiểm thử Giai đoạn 4 (Toàn diện: DROP_RATE 0.3, FAIL_RATE 0.3, Vượt hạn mức, Lỗi hỗn hợp, Hồi quy 1–3):**
  ```powershell
  node test-phase4.js
  ```
- **Các script đo đối chứng độc lập:**
  - `node measure-baseline.js`: Đo phản hồi khi ngân hàng tắt.
  - `node measure-baseline-delay.js`: Đo phản hồi khi ngân hàng trễ 5s trước tối ưu deadline.
  - `node measure-phase3-baseline.js`: Đo 200 thanh toán khi cấu hình đối chứng `keepAlive: false`.

---

## 5. Kết quả kiểm thử thực tế

Dưới đây là bảng tổng hợp số liệu đo đạc thực tế từ các kịch bản kiểm thử:

| Tình huống / Kịch bản kiểm thử | Cấu hình đối chứng (Trước tối ưu) | Phiên bản Cuối cùng (Sau tối ưu) | Tiêu chí đề bài | Đánh giá |
| :--- | :--- | :--- | :--- | :--- |
| **TH1: Ngân hàng tắt $\rightarrow$ POST thanh toán** | Chưa đo | **503 FAILED (111 ms)** | 503 FAILED, < 1.500 ms | **ĐẠT** |
| **TH1: Ngân hàng tắt $\rightarrow$ GET công nợ** | Chưa đo | **200 OK (4 ms)** | 200 OK, < 300 ms, Fee không sập | **ĐẠT** |
| **TH1: Bật lại ngân hàng (giữ Fee Service)** | Chưa đo | **201 PAID (22 ms)** | 201 PAID, không restart Fee | **ĐẠT** |
| **TH1: BANK_URL=http://localhost:4999** | Chưa đo | **503 FAILED (4 ms)** | 503 FAILED, < 1.500 ms | **ĐẠT** |
| **TH2: Ngân hàng DELAY_MS=5000 (1 request)** | 504 PENDING (5.080 ms) | **504 PENDING (4.044 ms)** | 504 PENDING, $\le$ 4.500 ms | **ĐẠT** |
| **TH2: Đồng thời 20 requests khi trễ 5s** | Chưa đo | **504 PENDING (Avg: 4.053 ms)** | Cả 20 requests $\le$ 4.500 ms | **ĐẠT** |
| **TH2: GET công nợ khi 20 request đang chờ** | Chưa đo | **200 OK (8 ms)** | 200 OK, < 300 ms | **ĐẠT** |
| **TH3: 200 thanh toán (10 worker đồng thời)** | 370 ms (`keepAlive: false`) | **255 ms** (`keepAlive: true`) | 200/200 thành công | **ĐẠT** |
| **TH3: Số kết nối TCP ngân hàng mở** | 200 kết nối | **10 kết nối TCP** | Không quá 20 kết nối | **ĐẠT (Giảm 95%)** |
| **TH3: Nhàn rỗi 6s, gọi tiếp thành công** | Chưa đo | **10 socket đóng sau 5s, gọi tiếp thành công 201 với kết nối mới** | Nhàn rỗi 6s, gọi tiếp thành công | **ĐẠT** |
| **TH4a: DROP_RATE=0.3 (60 thanh toán)** | Chưa đo | **60/60 PAID, duplicates = 0, requests = 80, nợ giảm đúng 60k** | $\ge 54/60$ PAID, duplicates = 0 | **ĐẠT** |
| **TH4b: FAIL_RATE=0.3 (60 thanh toán)** | Chưa đo | **60/60 PAID, duplicates = 0, requests = 83, nợ giảm đúng 60k** | $\ge 54/60$ PAID, không thu trùng | **ĐẠT** |
| **TH4c: Vượt hạn mức 25.000.000đ** | Chưa đo | **402 FAILED, requests tăng đúng 1, charges & nợ không đổi** | Trả 402, không retry | **ĐẠT** |
| **TH4d: Lỗi hỗn hợp có kiểm soát** | Chưa đo | **504 PENDING sau 3 lần thử (không nhầm FAILED)** | Phân loại đúng PENDING | **ĐẠT** |

---

## 6. Bốn khái niệm cốt lõi của bài thực hành

1. **Timeout (Thời hạn xử lý):**
   - Khi dịch vụ ngân hàng phản hồi chậm, nếu không đặt timeout thì các yêu cầu sẽ tích tụ, giữ kết nối mở kéo dài, chiếm dụng tài nguyên mạng (như socket pool) và trì hoãn phản hồi cho người dùng.
   - Fee Service áp dụng **ngân sách deadline tổng (4.000 ms)** tính từ lúc nhận request. Hết hạn, hệ thống hủy socket và trả về `504 PENDING` (thời gian đo ở client không quá 4.500 ms). Chức năng xem công nợ (`GET /fees`) luôn phản hồi siêu tốc (< 10 ms).
2. **Keep-Alive (Duy trì và tái sử dụng kết nối TCP):**
   - Fee Service sử dụng một `http.Agent` duy nhất với `keepAlive: true, maxSockets: 10`.
   - Kết quả: 200 giao dịch thanh toán liên tục chỉ tiêu tốn **đúng 10 kết nối TCP** (giảm 95% kết nối mạng); trong lượt đo thực tế ở Giai đoạn 3, thời gian hoàn thành giảm từ 370 ms xuống 255 ms (đây là số liệu đo đạc cụ thể trong môi trường thử nghiệm, không phải bảo đảm hiệu năng cố định trong mọi trường hợp).
3. **Retry (Thử lại có chọn lọc):**
   - Thử lại tối đa 3 lần với khoảng chờ ngắn (100 ms, 200 ms).
   - Chỉ retry lỗi tạm thời: HTTP 500 hoặc rớt mạng khi chờ phản hồi. Tuyệt đối không retry lỗi nghiệp vụ (400, 402) hay khi ngân hàng tắt (503).
   - Tất cả các lần thử dùng chung deadline 4.000 ms ban đầu, không reset deadline.
   - *Quy tắc phân loại kết quả:* Nếu retry nhận xác nhận giao dịch thành công thì trả PAID và giảm công nợ đúng một lần. Chỉ trả 504 PENDING khi kết thúc xử lý mà vẫn chưa xác định được kết quả.
4. **Tính lũy đẳng (Idempotency):**
   - Mỗi lệnh thanh toán có một `Idempotency-Key` duy nhất gắn với `paymentId`.
   - Ngân hàng lưu giao dịch ngay khi trừ tiền thành công. Khi nhận lại cùng khóa và cùng dữ liệu, ngân hàng trả lại ngay giao dịch cũ mà **không trừ tiền thêm lần nữa**.
   - Trong kịch bản `DROP_RATE=0.3`, kết quả 60 PAID xuất phát từ việc nhận lại giao dịch đã lưu bằng cùng Idempotency-Key, số lần thu tiền thực tế `charges` đúng bằng 60 và số lần thu trùng `duplicates` luôn bằng **0**.
