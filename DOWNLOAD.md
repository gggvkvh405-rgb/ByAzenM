# Скачать Cbopka 2.0

Репозиторий: `gggvkvh405-rgb/ByAzenM`. Файлы появляются на ветке `release-exe` после GitHub Actions **Build EXE** (windows-latest).

## Вариант 2 — нативное окно, не браузер

Electron: своё окно, иконка в трее, без адресной строки. Сервер внутри процесса запускается с `DISABLE_SQLITE=1` и `DISABLE_MULTER=1`, окно показывается после `ready-to-show`, `webSecurity: false`, клиент ищется в 5 путях. Это как раз фикс чёрного экрана и краша `3221225477`.

- https://github.com/gggvkvh405-rgb/ByAzenM/blob/release-exe/Cbopka-1.0.0-portable.exe
- https://github.com/gggvkvh405-rgb/ByAzenM/blob/release-exe/release/Cbopka-1.0.0-portable.exe

На странице blob нажмите **Download**. Raw-ссылки на файлы около 80 МБ GitHub иногда режет, blob стабильнее:

- https://github.com/gggvkvh405-rgb/ByAzenM/raw/release-exe/Cbopka-1.0.0-portable.exe
- https://github.com/gggvkvh405-rgb/ByAzenM/raw/release-exe/release/Cbopka-1.0.0-portable.exe

## Вариант 1 — один exe, локальный сервер

Node SEA, около размера официального `node.exe`. Двойной клик поднимает сервер и открывает браузер на `http://127.0.0.1:3000`. Нативные модули не грузятся.

- https://github.com/gggvkvh405-rgb/ByAzenM/blob/release-exe/Cbopka.exe
- https://github.com/gggvkvh405-rgb/ByAzenM/blob/release-exe/release/Cbopka.exe

## Если ссылка ещё 404

Сборка идёт в Actions и пушит файлы в `release-exe` отдельным коммитом. Откройте:

https://github.com/gggvkvh405-rgb/ByAzenM/actions/workflows/build-exe.yml

Там же артефакт `Cbopka-EXE-Windows`, если git-push файла упрётся в лимит GitHub.

## Другие оболочки

- Python + pywebview: `python Cbopka-Native.py` (окно WebView2, не вкладка)
- Tauri: `tauri/src-tauri` — системный webview, цель ~10 МБ
- Телефон: Actions **Build APK** или «Установить приложение» в Chrome (PWA)
