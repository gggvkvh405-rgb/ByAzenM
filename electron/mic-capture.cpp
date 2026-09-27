#define _WIN32_WINNT 0x0601
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <mmreg.h>
#include <ksmedia.h>
#include <mmsystem.h>
#include <propsys.h>
#include <process.h>

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "uuid.lib")

static volatile LONG gState = 0;
static volatile LONG gPeak = 0;
static volatile LONG gFail = 0;
static volatile LONG gRun = 1;
static SOCKET gSock = INVALID_SOCKET;
static CRITICAL_SECTION gSendCs;
static std::vector<uint8_t> gAcc;
static HWND gWnd = NULL;

static const wchar_t* kOpening = L"\u041E\u0442\u043A\u0440\u044B\u0432\u0430\u044E \u043C\u0438\u043A\u0440\u043E\u0444\u043E\u043D...";
static const wchar_t* kOpen = L"\u041C\u0438\u043A\u0440\u043E\u0444\u043E\u043D \u043E\u0442\u043A\u0440\u044B\u0442. \u0413\u043E\u0432\u043E\u0440\u0438\u0442\u0435.";
static const wchar_t* kFail = L"\u041D\u0435 \u043E\u0442\u043A\u0440\u044B\u043B\u0441\u044F";

static void notePeak(const uint8_t* pcm, int bytes) {
  int peak = 0;
  for (int i = 0; i + 1 < bytes; i += 32) {
    int s = (int)(int16_t)(pcm[i] | (pcm[i + 1] << 8));
    if (s < 0) s = -s;
    if (s > peak) peak = s;
  }
  if (peak > gPeak) gPeak = peak;
  else gPeak = (gPeak * 3) / 4;
}

static bool sendAll(const char* data, int len) {
  int off = 0;
  while (off < len) {
    int n = send(gSock, data + off, len - off, 0);
    if (n <= 0) return false;
    off += n;
  }
  return true;
}

static bool sendFrame(uint8_t type, const void* data, uint32_t len) {
  if (gSock == INVALID_SOCKET) return false;
  uint8_t head[5];
  head[0] = type;
  memcpy(head + 1, &len, 4);
  EnterCriticalSection(&gSendCs);
  bool ok = sendAll((const char*)head, 5) && (len == 0 || sendAll((const char*)data, (int)len));
  LeaveCriticalSection(&gSendCs);
  return ok;
}

static void sendText(const char* text) {
  sendFrame(1, text, (uint32_t)strlen(text));
}

static void pushPcm(const uint8_t* pcm, int bytes) {
  if (!pcm || bytes <= 0) return;
  notePeak(pcm, bytes);
  gAcc.insert(gAcc.end(), pcm, pcm + bytes);
  while (gAcc.size() >= 3200) {
    if (!sendFrame(2, gAcc.data(), 3200)) { gRun = 0; return; }
    gAcc.erase(gAcc.begin(), gAcc.begin() + 3200);
  }
}

static int sampleAt(const uint8_t* raw, int off, int bps, bool floating) {
  if (floating && bps >= 4) {
    float f;
    memcpy(&f, raw + off, 4);
    if (f > 1.f) f = 1.f;
    if (f < -1.f) f = -1.f;
    return (int)(f * 32767.f);
  }
  if (bps >= 4) {
    int32_t v;
    memcpy(&v, raw + off, 4);
    return v >> 16;
  }
  int16_t v;
  memcpy(&v, raw + off, 2);
  return v;
}

static void to16k(const uint8_t* raw, int frames, int channels, int rate, int bits, bool floating) {
  if (!raw || frames <= 0 || channels <= 0 || rate <= 0) return;
  int bps = bits / 8;
  if (bps < 2) bps = 2;
  double ratio = (double)rate / 16000.0;
  int outFrames = (int)(frames / ratio);
  if (outFrames < 1) outFrames = 1;
  std::vector<uint8_t> out((size_t)outFrames * 2);
  for (int i = 0; i < outFrames; i++) {
    int start = (int)(i * ratio);
    int end = (int)((i + 1) * ratio);
    if (end <= start) end = start + 1;
    if (end > frames) end = frames;
    long sum = 0;
    int count = 0;
    for (int f = start; f < end; f++) {
      int off = f * channels * bps;
      int sample = sampleAt(raw, off, bps, floating);
      if (channels > 1) {
        int off2 = off + bps;
        sample = (sample + sampleAt(raw, off2, bps, floating)) / 2;
      }
      sum += sample;
      count++;
    }
    int16_t s = count ? (int16_t)(sum / count) : 0;
    out[i * 2] = (uint8_t)(s & 255);
    out[i * 2 + 1] = (uint8_t)((s >> 8) & 255);
  }
  pushPcm(out.data(), (int)out.size());
}

static void hexHr(HRESULT hr, char* buf, int n) {
  sprintf_s(buf, n, "%08X", (unsigned)hr);
}

static bool connectPort(int port) {
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
  for (int i = 0; i < 50 && gRun; i++) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;
    sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    if (connect(s, (sockaddr*)&addr, sizeof(addr)) == 0) {
      int one = 1;
      setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (char*)&one, sizeof(one));
      gSock = s;
      return true;
    }
    closesocket(s);
    Sleep(100);
  }
  return false;
}

static void relaxDevice(IMMDevice* dev) {
  IPropertyStore* store = NULL;
  if (!dev || FAILED(dev->OpenPropertyStore(STGM_READWRITE, &store)) || !store) return;
  PROPERTYKEY allow = { { 0xB3F8FA53, 0x0004, 0x438E, { 0x90, 0x03, 0x51, 0xA4, 0x6E, 0x13, 0x9B, 0xFC } }, 3 };
  PROPERTYKEY prio = allow;
  prio.pid = 4;
  PROPERTYKEY fx = { { 0x1DA5D803, 0xD492, 0x4EDD, { 0x8C, 0x23, 0xE0, 0xC0, 0xFF, 0xEE, 0x7F, 0x0E } }, 5 };
  PROPVARIANT off;
  memset(&off, 0, sizeof(off));
  off.vt = VT_UI4;
  off.ulVal = 0;
  store->SetValue(allow, off);
  store->SetValue(prio, off);
  off.ulVal = 1;
  store->SetValue(fx, off);
  store->Commit();
  store->Release();
}

static bool readFormat(const WAVEFORMATEX* fmt, int* rate, int* ch, int* bits, int* align, bool* floating) {
  if (!fmt) return false;
  *ch = fmt->nChannels > 0 ? fmt->nChannels : 1;
  *rate = fmt->nSamplesPerSec > 0 ? (int)fmt->nSamplesPerSec : 48000;
  *bits = fmt->wBitsPerSample > 0 ? fmt->wBitsPerSample : 16;
  *align = fmt->nBlockAlign > 0 ? fmt->nBlockAlign : (*ch * (*bits / 8));
  *floating = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
  if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && fmt->cbSize >= 22) {
    const WAVEFORMATEXTENSIBLE* ext = (const WAVEFORMATEXTENSIBLE*)fmt;
    if (ext->SubFormat.Data1 == 3) *floating = true;
    if (ext->SubFormat.Data1 == 1) *floating = false;
  }
  return *align > 0;
}

static IAudioClient* gClient = NULL;
static IAudioCaptureClient* gCapture = NULL;
static int gRate = 16000, gCh = 1, gBits = 16, gAlign = 2;
static bool gFloat = false;

static bool startWasapi(IAudioClient* client, WAVEFORMATEX* fmt) {
  if (!readFormat(fmt, &gRate, &gCh, &gBits, &gAlign, &gFloat)) return false;
  IAudioCaptureClient* cap = NULL;
  HRESULT hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&cap);
  if (FAILED(hr) || !cap) return false;
  hr = client->Start();
  if (FAILED(hr)) { cap->Release(); return false; }
  gClient = client;
  gCapture = cap;
  return true;
}

static bool openClient(IMMDevice* dev, bool mix, char* err) {
  IAudioClient* client = NULL;
  HRESULT hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&client);
  if (FAILED(hr) || !client) { hexHr(hr, err, 16); return false; }
  if (mix) {
    WAVEFORMATEX* fmt = NULL;
    hr = client->GetMixFormat(&fmt);
    if (FAILED(hr) || !fmt) { hexHr(hr, err, 16); client->Release(); return false; }
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 0, 0, fmt, NULL);
    if (FAILED(hr)) { hexHr(hr, err, 16); CoTaskMemFree(fmt); client->Release(); return false; }
    bool ok = startWasapi(client, fmt);
    CoTaskMemFree(fmt);
    if (!ok) { client->Stop(); client->Release(); return false; }
    return true;
  }
  WAVEFORMATEX pcm;
  memset(&pcm, 0, sizeof(pcm));
  pcm.wFormatTag = WAVE_FORMAT_PCM;
  pcm.nChannels = 1;
  pcm.nSamplesPerSec = 16000;
  pcm.wBitsPerSample = 16;
  pcm.nBlockAlign = 2;
  pcm.nAvgBytesPerSec = 32000;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 0, 0, &pcm, NULL);
  if (FAILED(hr)) { hexHr(hr, err, 16); client->Release(); return false; }
  if (!startWasapi(client, &pcm)) { client->Stop(); client->Release(); return false; }
  return true;
}

static bool tryWasapi(char* err) {
  strcpy_s(err, 16, "1");
  IMMDeviceEnumerator* en = NULL;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en);
  if (FAILED(hr) || !en) { hexHr(hr, err, 16); return false; }
  IMMDevice* seen[12];
  int nseen = 0;
  ERole roles[3] = { eConsole, eCommunications, eMultimedia };
  for (int r = 0; r < 3 && nseen < 12; r++) {
    IMMDevice* dev = NULL;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(eCapture, roles[r], &dev)) && dev) seen[nseen++] = dev;
  }
  IMMDeviceCollection* col = NULL;
  if (SUCCEEDED(en->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &col)) && col) {
    UINT count = 0;
    col->GetCount(&count);
    for (UINT i = 0; i < count && nseen < 12; i++) {
      IMMDevice* dev = NULL;
      if (SUCCEEDED(col->Item(i, &dev)) && dev) seen[nseen++] = dev;
    }
    col->Release();
  }
  bool opened = false;
  for (int i = 0; i < nseen && !opened; i++) {
    relaxDevice(seen[i]);
    if (openClient(seen[i], true, err) || openClient(seen[i], false, err)) opened = true;
    seen[i]->Release();
  }
  en->Release();
  return opened;
}

static void pullWasapi() {
  while (gRun && gCapture) {
    UINT32 packet = 0;
    HRESULT hr = gCapture->GetNextPacketSize(&packet);
    if (FAILED(hr)) break;
    if (packet == 0) { Sleep(10); continue; }
    BYTE* data = NULL;
    UINT32 frames = 0;
    DWORD flags = 0;
    hr = gCapture->GetBuffer(&data, &frames, &flags, NULL, NULL);
    if (FAILED(hr)) break;
    int bytes = (int)frames * gAlign;
    if (bytes > 0 && data) to16k(data, (int)frames, gCh, gRate, gBits, gFloat);
    gCapture->ReleaseBuffer(frames);
  }
}

static HWAVEIN gWave = NULL;
static WAVEHDR gHdr[3];
static uint8_t* gBuf[3] = { NULL, NULL, NULL };
static HANDLE gEvent = NULL;
static int gWaveRate = 16000;
static int gWaveCh = 1;

static void cleanupWave() {
  if (gWave) {
    waveInStop(gWave);
    waveInReset(gWave);
    for (int i = 0; i < 3; i++) {
      if (gHdr[i].lpData) waveInUnprepareHeader(gWave, &gHdr[i], sizeof(WAVEHDR));
    }
    waveInClose(gWave);
    gWave = NULL;
  }
  for (int i = 0; i < 3; i++) { delete[] gBuf[i]; gBuf[i] = NULL; gHdr[i].lpData = NULL; }
  if (gEvent) { CloseHandle(gEvent); gEvent = NULL; }
}

static int openWave(UINT dev, DWORD rate, WORD ch, DWORD flags, DWORD_PTR cb) {
  WAVEFORMATEX fmt;
  memset(&fmt, 0, sizeof(fmt));
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = ch;
  fmt.nSamplesPerSec = rate;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = (WORD)(ch * 2);
  fmt.nAvgBytesPerSec = rate * fmt.nBlockAlign;
  HWAVEIN h = NULL;
  MMRESULT mr = waveInOpen(&h, dev, &fmt, cb, 0, flags);
  if (mr != MMSYSERR_NOERROR) return (int)mr;
  int bytes = (int)(rate * fmt.nBlockAlign / 10);
  if (bytes < 640) bytes = 640;
  for (int i = 0; i < 3; i++) {
    gBuf[i] = new uint8_t[bytes];
    memset(&gHdr[i], 0, sizeof(WAVEHDR));
    gHdr[i].lpData = (LPSTR)gBuf[i];
    gHdr[i].dwBufferLength = bytes;
    mr = waveInPrepareHeader(h, &gHdr[i], sizeof(WAVEHDR));
    if (mr != MMSYSERR_NOERROR) { gWave = h; cleanupWave(); return (int)mr; }
    mr = waveInAddBuffer(h, &gHdr[i], sizeof(WAVEHDR));
    if (mr != MMSYSERR_NOERROR) { gWave = h; cleanupWave(); return (int)mr; }
  }
  mr = waveInStart(h);
  if (mr != MMSYSERR_NOERROR) { gWave = h; cleanupWave(); return (int)mr; }
  gWave = h;
  gWaveRate = (int)rate;
  gWaveCh = ch;
  return 0;
}

static bool tryWave(char* err) {
  strcpy_s(err, 16, "1");
  UINT ids[16];
  int n = 0;
  ids[n++] = WAVE_MAPPER;
  UINT count = waveInGetNumDevs();
  for (UINT i = 0; i < count && n < 16; i++) ids[n++] = i;
  DWORD rates[4] = { 48000, 44100, 16000, 22050 };
  WORD chs[2] = { 1, 2 };
  DWORD modes[2] = { CALLBACK_EVENT, CALLBACK_NULL };
  for (int d = 0; d < n; d++) {
    for (int m = 0; m < 2; m++) {
      for (int r = 0; r < 4; r++) {
        for (int c = 0; c < 2; c++) {
          cleanupWave();
          DWORD_PTR cb = 0;
          if (modes[m] == CALLBACK_EVENT) {
            gEvent = CreateEvent(NULL, FALSE, FALSE, NULL);
            cb = (DWORD_PTR)gEvent;
          }
          int code = openWave(ids[d], rates[r], chs[c], modes[m], cb);
          if (code == 0) return true;
          sprintf_s(err, 16, "%d", code);
        }
      }
    }
  }
  return false;
}

static void pullWave() {
  while (gRun && gWave) {
    if (gEvent) WaitForSingleObject(gEvent, 80);
    else Sleep(20);
    for (int i = 0; i < 3; i++) {
      if (gHdr[i].dwFlags & WHDR_DONE) {
        if (gHdr[i].dwBytesRecorded > 0) {
          int frames = (int)gHdr[i].dwBytesRecorded / (gWaveCh * 2);
          to16k((const uint8_t*)gHdr[i].lpData, frames, gWaveCh, gWaveRate, 16, false);
        }
        waveInAddBuffer(gWave, &gHdr[i], sizeof(WAVEHDR));
      }
    }
  }
}

static unsigned __stdcall captureThread(void* arg) {
  int port = (int)(intptr_t)arg;
  CoInitializeEx(NULL, COINIT_MULTITHREADED);
  Sleep(200);
  if (!connectPort(port)) { gState = 2; CoUninitialize(); return 0; }
  char wasapi[16] = "1";
  char wave[16] = "1";
  bool opened = false;
  const char* engine = "wasapi";
  if (tryWasapi(wasapi)) { opened = true; engine = "wasapi"; }
  else if (tryWave(wave)) { opened = true; engine = "wave"; }
  if (!opened) {
    gFail = 1;
    gState = 2;
    char msg[64];
    sprintf_s(msg, "FAIL\t%s\t%s", wasapi, wave);
    sendText(msg);
    CoUninitialize();
    return 0;
  }
  gState = 1;
  char ready[64];
  sprintf_s(ready, "READY\t%s\tdefault\t16000\t1", engine);
  sendText(ready);
  if (gCapture) pullWasapi();
  else pullWave();
  gRun = 0;
  if (gClient) { gClient->Stop(); gClient->Release(); gClient = NULL; }
  if (gCapture) { gCapture->Release(); gCapture = NULL; }
  cleanupWave();
  CoUninitialize();
  return 0;
}

static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_CLOSE) { ShowWindow(hwnd, SW_HIDE); return 0; }
  if (msg == WM_TIMER) { InvalidateRect(hwnd, NULL, FALSE); return 0; }
  if (msg == WM_PAINT) {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(hwnd, &ps);
    RECT rc;
    GetClientRect(hwnd, &rc);
    HBRUSH bg = CreateSolidBrush(RGB(18, 16, 14));
    FillRect(dc, &rc, bg);
    DeleteObject(bg);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(246, 241, 232));
    HFONT font = CreateFontW(22, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    HGDIOBJ old = SelectObject(dc, font);
    const wchar_t* text = gState == 1 ? kOpen : (gState == 2 ? kFail : kOpening);
    RECT tr = rc;
    tr.bottom = 78;
    DrawTextW(dc, text, -1, &tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(dc, old);
    DeleteObject(font);
    int peak = gPeak;
    if (peak < 0) peak = 0;
    if (peak > 32767) peak = 32767;
    int barW = (rc.right - 48) * peak / 32767;
    RECT track = { 24, 88, rc.right - 24, 112 };
    HBRUSH trackBr = CreateSolidBrush(RGB(42, 36, 32));
    FillRect(dc, &track, trackBr);
    DeleteObject(trackBr);
    if (barW > 0) {
      RECT bar = track;
      bar.right = bar.left + barW;
      HBRUSH barBr = CreateSolidBrush(RGB(255, 106, 69));
      FillRect(dc, &bar, barBr);
      DeleteObject(barBr);
    }
    EndPaint(hwnd, &ps);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, LPWSTR cmd, int) {
  int port = _wtoi(cmd ? cmd : L"");
  if (port <= 0) return 1;
  InitializeCriticalSection(&gSendCs);
  WNDCLASSW wc;
  memset(&wc, 0, sizeof(wc));
  wc.lpfnWndProc = wndProc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.lpszClassName = L"CbopkaMicWnd";
  RegisterClassW(&wc);
  int sw = GetSystemMetrics(SM_CXSCREEN);
  int sh = GetSystemMetrics(SM_CYSCREEN);
  gWnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, L"CbopkaMicWnd", L"Cbopka",
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, (sw - 440) / 2, (sh - 180) / 2, 440, 180,
    NULL, NULL, inst, NULL);
  ShowWindow(gWnd, SW_SHOW);
  UpdateWindow(gWnd);
  SetForegroundWindow(gWnd);
  SetTimer(gWnd, 1, 50, NULL);
  uintptr_t th = _beginthreadex(NULL, 0, captureThread, (void*)(intptr_t)port, 0, NULL);
  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  gRun = 0;
  if (th) { WaitForSingleObject((HANDLE)th, 1500); CloseHandle((HANDLE)th); }
  if (gSock != INVALID_SOCKET) closesocket(gSock);
  DeleteCriticalSection(&gSendCs);
  return 0;
}
