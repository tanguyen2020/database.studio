# Database Studio — Cài đặt trên Ubuntu / Debian

Hướng dẫn cài đặt **Database Studio** (Tauri 2) trên Ubuntu (20.04 / 22.04 / 24.04) và các bản Debian tương thích. Gồm cách cài gói `.deb`, **phân quyền để cài được**, cách chạy AppImage, và cách tự build từ mã nguồn.

> Tên gói: **Database Studio** · phiên bản **0.1.0** · app id `studio.database.app`
> Artifact chính: `Database Studio_0.1.0_amd64.deb` (kiến trúc x86-64).

---

## 1. Yêu cầu hệ thống (runtime)

Ứng dụng dùng WebKitGTK để render giao diện. Trên Ubuntu 22.04+ cần **webkit2gtk 4.1**:

| Ubuntu | Thư viện WebKit runtime |
|---|---|
| 22.04 / 24.04 | `libwebkit2gtk-4.1-0` |
| 20.04 | `libwebkit2gtk-4.0-37` (build lại với target 4.0 — xem §6) |

Các thư viện GTK/soup/appindicator thường đã có sẵn; nếu thiếu, bước `apt-get install -f` ở §2 sẽ tự kéo về.

---

## 2. Cài từ gói `.deb` (khuyến nghị)

### 2.1. Vì sao cần `sudo` (phân quyền)

Cài `.deb` **ghi vào thư mục hệ thống** (`/usr/bin`, `/usr/lib`, `/usr/share/applications`…). Ghi vào đây đòi hỏi **quyền root**, nên mọi lệnh cài đặt phải chạy qua `sudo`. Tài khoản của bạn phải thuộc nhóm `sudo` (mặc định tài khoản đầu tiên khi cài Ubuntu đã có). Kiểm tra:

```bash
groups | tr ' ' '\n' | grep -x sudo && echo "OK: có quyền sudo" || echo "Thiếu: nhờ admin thêm bạn vào nhóm sudo"
```

Nếu thiếu, một admin chạy: `sudo usermod -aG sudo <tên_user>` rồi đăng xuất/đăng nhập lại.

### 2.2. Cấp quyền đọc cho file `.deb` (nếu tải về bị hạn chế)

File `.deb` chỉ cần quyền **đọc** cho `dpkg`. Nếu bạn copy từ USB/mạng và gặp lỗi permission, đặt lại quyền:

```bash
cd ~/Downloads
chmod 644 "Database Studio_0.1.0_amd64.deb"      # rw cho chủ sở hữu, r cho nhóm/khác
# nếu file thuộc user khác (vd root):
sudo chown "$USER":"$USER" "Database Studio_0.1.0_amd64.deb"
```

### 2.3. Cài đặt

**Cách A — apt (tự giải quyết dependency, khuyến nghị):**
```bash
sudo apt-get update
sudo apt-get install ./"Database Studio_0.1.0_amd64.deb"
```
> Dùng đường dẫn có `./` để apt hiểu đây là file cục bộ, không phải tên gói trên repo.

**Cách B — dpkg rồi sửa dependency thiếu:**
```bash
sudo dpkg -i "Database Studio_0.1.0_amd64.deb"
sudo apt-get install -f          # kéo về mọi thư viện còn thiếu (webkit2gtk…)
```

### 2.4. Chạy ứng dụng

- Mở từ menu ứng dụng: tìm **“Database Studio”**.
- Hoặc từ terminal:
```bash
database-studio         # binary được cài vào /usr/bin
```

### 2.5. Gỡ cài đặt
```bash
sudo apt-get remove database-studio       # giữ cấu hình
sudo apt-get purge  database-studio        # xoá luôn cấu hình
```

---

## 3. Cách chạy bản AppImage (không cần cài, không cần root)

Nếu bạn có file `.AppImage` (xem lưu ý build ở §5), AppImage **chạy trực tiếp không cần sudo** — nhưng phải cấp **quyền thực thi**:

```bash
cd ~/Downloads
chmod +x "Database Studio_0.1.0_amd64.AppImage"   # cấp cờ execute (x)
./"Database Studio_0.1.0_amd64.AppImage"
```

AppImage cần **FUSE** để mount. Nếu gặp lỗi `dlopen(): libfuse.so.2` hoặc `fuse: failed to exec fusermount`:
```bash
# Ubuntu 22.04+ (FUSE 2 không cài mặc định):
sudo apt-get install -y libfuse2
# hoặc chạy không cần FUSE (giải nén rồi chạy):
./"Database Studio_0.1.0_amd64.AppImage" --appimage-extract-and-run
```

> Không đặt AppImage ở thư mục mount với cờ `noexec` (vd một số USB). Kiểm tra: `mount | grep noexec`.

---

## 4. Bảng tóm tắt phân quyền

| Việc | Lệnh phân quyền | Vì sao |
|---|---|---|
| Cài `.deb` | `sudo apt-get install ./*.deb` | Ghi vào `/usr` → cần root |
| User có quyền cài | thuộc nhóm `sudo` (`usermod -aG sudo`) | dpkg yêu cầu root |
| `.deb` bị khoá đọc | `chmod 644 file.deb` / `chown $USER file.deb` | dpkg cần đọc file |
| Chạy AppImage | `chmod +x file.AppImage` | cần cờ execute |
| AppImage mount | `sudo apt-get install libfuse2` | AppImage dùng FUSE |
| Build từ nguồn | `sudo apt-get install <deps>` | cài lib dev vào hệ thống |

---

## 5. Lưu ý về định dạng gói

- **`.deb`**: cách cài chuẩn trên Ubuntu/Debian, tích hợp menu + gỡ cài sạch. Đây là artifact chúng tôi build sẵn.
- **AppImage**: 1 file chạy mọi nơi, không cần cài. Việc **build** AppImage cần công cụ `patchelf` (`sudo apt-get install patchelf`) + `libfuse2`; nếu môi trường build thiếu `patchelf` thì chỉ tạo `.deb`. Bản `.deb` đã đủ dùng cho Ubuntu.
- **`.rpm`** (Fedora/RHEL): build bằng `--bundles rpm` (cần `rpm`/`rpmbuild`).

---

## 6. Tự build từ mã nguồn trên Ubuntu

### 6.1. Cài phụ thuộc hệ thống (cần `sudo`)

**Ubuntu 22.04 / 24.04:**
```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  patchelf                      # để đóng AppImage; bỏ nếu chỉ cần .deb
# librdkafka (driver Kafka) build qua CMake:
sudo apt-get install -y cmake
```

**Ubuntu 20.04** dùng WebKit 4.0 thay vì 4.1:
```bash
sudo apt-get install -y libwebkit2gtk-4.0-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev build-essential \
  curl wget file libssl-dev pkg-config cmake patchelf
```

### 6.2. Cài Rust + Node (KHÔNG cần sudo)

```bash
# Rust (rustup, cài vào ~/.cargo — cấp quyền cho user, không đụng hệ thống)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Node ≥ 20 (nvm cài vào ~/.nvm — không cần sudo)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 22 && nvm use 22
```

### 6.3. Build

```bash
git clone <repo-url> database-studio
cd database-studio
npm ci                                   # cài devDependencies (gồm @tauri-apps/cli)
npm run tauri build -- --bundles deb     # chỉ .deb
# hoặc cả hai (cần patchelf + libfuse2):
# npm run tauri build -- --bundles deb,appimage
```

### 6.4. Vị trí artifact sau build

```
src-tauri/target/release/bundle/deb/Database Studio_0.1.0_amd64.deb
src-tauri/target/release/bundle/appimage/Database Studio_0.1.0_amd64.AppImage   # nếu build appimage
src-tauri/target/release/database-studio                                        # binary trần
```

Nếu quá trình build cần cấp quyền thực thi cho binary tự sinh (hiếm):
```bash
chmod +x src-tauri/target/release/database-studio
```

---

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `dpkg: dependency problems` | thiếu thư viện runtime | `sudo apt-get install -f` |
| `error while loading shared libraries: libwebkit2gtk-4.1.so.0` | thiếu WebKit runtime | `sudo apt-get install libwebkit2gtk-4.1-0` |
| Cửa sổ trắng / không render | GPU/driver | chạy `WEBKIT_DISABLE_COMPOSITING_MODE=1 database-studio` |
| AppImage: `fusermount: not found` | thiếu FUSE | `sudo apt-get install libfuse2` hoặc `--appimage-extract-and-run` |
| `Permission denied` khi chạy AppImage | thiếu cờ execute | `chmod +x *.AppImage` |
| `E: Unable to locate package …-dev` (build) | thiếu `apt-get update` hoặc sai tên gói theo bản Ubuntu | chạy `sudo apt-get update`; 20.04 dùng `-4.0-dev`, 22.04+ dùng `-4.1-dev` |

---

## 8. Ghi chú build đa nền

- Gói Ubuntu **không thể build từ Windows trực tiếp** (Tauri cần công cụ đóng gói Linux). Cách khả thi: build **trong WSL2 Ubuntu** trên máy Windows, hoặc trên máy/VM/CI Linux — rồi mới ra `.deb`/AppImage.
- Bản Windows (`.msi`/NSIS `.exe`) build native trên Windows bằng `npm run tauri build`.
