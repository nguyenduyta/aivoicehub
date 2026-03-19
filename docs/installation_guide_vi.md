# Cài đặt (macOS)

Hướng dẫn cài và sử dụng **AIVoiceHub** trên macOS.

## Yêu cầu

- macOS 13+
- **Dịch Cloud**: cần **Soniox API key**
- **Local mode (Apple Silicon)**: ~5GB để tải model (1 lần)
- **TTS** (tuỳ chọn): xem [Hướng dẫn TTS](tts_guide_vi.md)

## Cài đặt (khuyến nghị)

1. Tải `.dmg` mới nhất: [**Releases — macOS**](https://github.com/phuc-nt/aivoicehub/releases/latest)
2. Mở `.dmg` → kéo **AIVoiceHub** vào **Applications**
3. Mở **AIVoiceHub**

## Cấp quyền (bắt hệ thống audio)

macOS sẽ hỏi quyền **Screen Recording** (dùng để bắt âm thanh hệ thống):

1. Mở **System Settings** khi được hỏi
2. Tìm **AIVoiceHub** → bật **ON**
3. Quit & reopen khi macOS yêu cầu

## Cấu hình trong app

Mở **Settings** (`⌘ ,`) và cấu hình:

- **Soniox API key** (bắt buộc nếu dùng cloud)
- **Source / Target language**
- **Engine**: Cloud (Soniox) hoặc Local MLX (Apple Silicon)
- **OpenAI API key** (tuỳ chọn, dùng cho nút Summary)

## Bắt đầu dịch

- **`⌘ Enter`**: Start/Stop
- Chọn **System Audio** hoặc **Microphone**
- **`⌘ T`**: bật/tắt TTS (tuỳ chọn)

## Phím tắt

| Phím tắt | Chức năng |
|----------|-----------|
| `⌘ Enter` | Bắt đầu / Dừng |
| `⌘ ,` | Mở Settings |
| `Esc` | Đóng Settings |
| `⌘ 1` | System Audio |
| `⌘ 2` | Microphone |
| `⌘ T` | Bật/tắt TTS |

## Build từ mã nguồn (developer)

```bash
git clone https://github.com/phuc-nt/aivoicehub.git
cd aivoicehub
yarn install
yarn dev
```

Build release:

```bash
yarn build
```

Xem [Developing](developing.md) (EN) để cài Rust + Xcode.

## Xử lý sự cố

- **Không hiện text**: kiểm tra quyền Screen Recording đã bật cho AIVoiceHub.
- **Thiếu API key**: dán Soniox key trong Settings.
- **Không có mic**: dùng mic ngoài (Mac mini không có mic tích hợp).
