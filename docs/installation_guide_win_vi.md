# Cài đặt (Windows)

Hướng dẫn cài và sử dụng **AIVoiceHub** trên Windows 10/11.

## Yêu cầu

- Windows 10+
- **Soniox API key** (dịch cloud)
- WebView2 Runtime (thường có sẵn trên Windows 10/11)

## Cài đặt

1. Tải bản mới nhất: [**Releases — Windows**](https://github.com/phuc-nt/aivoicehub/releases/latest)
2. Chạy file `.exe`
3. Nếu SmartScreen chặn: **More info** → **Run anyway**

## Cấu hình trong app

Mở **Settings** và đặt:

- **Soniox API key**
- **Source / Target language**
- **Audio source**: System Audio hoặc Microphone
- **OpenAI API key** (tuỳ chọn, dùng cho nút Summary)

## Bắt đầu dịch

- **`Ctrl+Enter`**: Start/Stop
- **`Ctrl+T`**: bật/tắt TTS (tuỳ chọn)

## Phím tắt

| Phím tắt | Chức năng |
|----------|-----------|
| `Ctrl+Enter` | Bắt đầu / Dừng |
| `Ctrl+,` | Mở Settings |
| `Esc` | Đóng Settings |
| `Ctrl+T` | Bật/tắt TTS |

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

Xem [Developing](developing.md) (EN).

## Khắc phục sự cố

- **Không hiện bản dịch**: kiểm tra Soniox key trong Settings.
- **Không bắt được system audio**: đảm bảo đang phát audio; một số app dùng exclusive mode.
- **App không mở**: cài WebView2 Runtime từ Microsoft.
