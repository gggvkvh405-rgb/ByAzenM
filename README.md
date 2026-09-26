# Cbopka 2.0

Мессенджер, который открывается как приложение, а не как вкладка. Личные чаты, комнаты с каналами, голос 24/7, звонки за NAT.

## Скачать

Рабочие ссылки и что чем отличается — в [DOWNLOAD.md](DOWNLOAD.md).

- Нативное окно (Electron, трей, без Chrome): `Cbopka-1.0.0-portable.exe`
- Портативный сервер (SEA, открывает локальный сервер): `Cbopka.exe`

Оба файла собирает GitHub Actions на `windows-latest` и кладёт в корень ветки `release-exe` и в `release/`.

## Запуск из исходников

```bash
npm install --prefix client && npm install --prefix server
npm run build --prefix client
node server/index.js
# http://127.0.0.1:3000
```

Нативное окно на машине с Electron:

```bash
cd electron && npm install && npm start
```

Сервер в этом режиме стартует с `DISABLE_SQLITE=1` и `DISABLE_MULTER=1`, чтобы не словить Access Violation `3221225477` (`0xC0000005`) от нативных модулей.

## Что внутри

- React + Vite + Tailwind, PWA (service worker, push)
- Socket.IO: чаты 1-1 и группы, роли, инвайты, каналы, голос
- WebRTC: голос, видео, экран до 4K60, TURN (coturn) + STUN
- Групповые звонки: mesh по умолчанию, mediasoup SFU если `ENABLE_MEDIASOUP=1`
- Шумодав (WebRTC NS + AudioWorklet, RNNoise с CDN если доступен)
- Виртуальный фон MediaPipe, запись звонка, реакции, рука, push-to-talk, рисование на экране
- История, поиск, файлы, голосовые с waveform, GIF (Tenor), стикеры, реакции, треды, опросы, markdown
- E2E в личках (эфемерный ECDH + AES-GCM), 2FA TOTP, пин, скрытые чаты
- Темы dark / light / AMOLED / свой акцент
- Electron: трей, автозапуск, горячие клавиши, оверлей, electron-updater
- Tauri-исходник, Python + pywebview, Capacitor APK, Docker + coturn

База: SQLite через `better-sqlite3`, если модуль есть и не запрещён. Иначе in-memory Maps и JSON в `DATA_DIR`, без нативного кода.
