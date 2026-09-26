using System;
using System.Collections.Generic;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;

public class CbopkaMic {
  static NetworkStream ns;
  static volatile bool go;
  static readonly object sendGate = new object();
  static List<byte> acc = new List<byte>();

  public static void Main(string[] args) {
    int port = 0;
    if (args.Length > 0) int.TryParse(args[0], out port);
    if (port > 0) Run(port);
  }

  public static void Run(int port) {
    try { CoInitializeEx(IntPtr.Zero, 0); } catch {}
    TcpClient client = Connect(port);
    if (client == null) return;
    ns = client.GetStream();
    try {
      string wasapiErr = null;
      string waveErr = null;
      if (TryWasapi(out wasapiErr) && WasapiAlive()) {
        SendText("READY\twasapi\tdefault\t" + capRate + "\t" + capChannels);
        PullWasapi(client);
        return;
      }
      StopWasapi();
      if (TryWave(out waveErr)) {
        SendText("READY\twave\t" + Safe(waveName) + "\t" + waveRate + "\t" + waveChannels);
        PullWave(client);
        return;
      }
      SendText("FAIL\t" + (wasapiErr ?? waveErr ?? "open") + "\tcapture");
    } catch (Exception ex) {
      try { SendText("FAIL\t0\t" + Safe(ex.Message)); } catch {}
    } finally {
      go = false;
      StopWasapi();
      CleanupWave();
      try { client.Close(); } catch {}
    }
  }

  static TcpClient Connect(int port) {
    for (int i = 0; i < 50; i++) {
      try {
        TcpClient c = new TcpClient();
        c.NoDelay = true;
        c.Connect("127.0.0.1", port);
        return c;
      } catch {
        Thread.Sleep(100);
      }
    }
    return null;
  }

  static string Safe(string s) {
    if (string.IsNullOrEmpty(s)) return "mic";
    return s.Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
  }

  static void SendText(string text) {
    Send(1, System.Text.Encoding.UTF8.GetBytes(text));
  }

  static void Send(byte type, byte[] payload) {
    if (ns == null) return;
    int n = payload == null ? 0 : payload.Length;
    byte[] head = new byte[5];
    head[0] = type;
    head[1] = (byte)(n & 255);
    head[2] = (byte)((n >> 8) & 255);
    head[3] = (byte)((n >> 16) & 255);
    head[4] = (byte)((n >> 24) & 255);
    lock (sendGate) {
      ns.Write(head, 0, 5);
      if (n > 0) ns.Write(payload, 0, n);
      ns.Flush();
    }
  }

  static void PushPcm(byte[] pcm) {
    if (pcm == null || pcm.Length == 0) return;
    for (int i = 0; i < pcm.Length; i++) acc.Add(pcm[i]);
    while (acc.Count >= 3200) {
      byte[] frame = new byte[3200];
      acc.CopyTo(0, frame, 0, 3200);
      acc.RemoveRange(0, 3200);
      Send(2, frame);
    }
  }

  static int capRate = 16000;
  static int capChannels = 1;
  static int capBits = 16;
  static int capAlign = 2;
  static bool capFloat = false;
  static IAudioClient audioClient;
  static IAudioCaptureClient capture;
  static bool wasapiOn;

  static bool TryWasapi(out string err) {
    err = null;
    try {
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      int[] roles = new int[] { 0, 2 };
      for (int r = 0; r < roles.Length; r++) {
        string one;
        if (TryEndpoint(en, roles[r], true, out one)) return true;
        err = one;
        if (TryEndpoint(en, roles[r], false, out one)) return true;
        err = one;
      }
    } catch (Exception ex) {
      err = Safe(ex.Message);
    }
    return false;
  }

  static bool TryEndpoint(IMMDeviceEnumerator en, int role, bool pcm16, out string err) {
    err = null;
    IMMDevice dev = null;
    int hr = en.GetDefaultAudioEndpoint(1, role, out dev);
    if (hr != 0 || dev == null) { err = hr.ToString("X8"); return false; }
    Guid iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    object obj = null;
    hr = dev.Activate(ref iid, 23, IntPtr.Zero, out obj);
    if (hr != 0 || obj == null) { err = hr.ToString("X8"); return false; }
    IAudioClient client = (IAudioClient)obj;
    bool ready = pcm16 ? InitPcm16(client, out err) : InitMix(client, out err);
    if (!ready) { StopClient(client); return false; }
    Guid capId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    object capObj = null;
    hr = client.GetService(ref capId, out capObj);
    if (hr != 0 || capObj == null) { err = hr.ToString("X8"); StopClient(client); return false; }
    capture = (IAudioCaptureClient)capObj;
    hr = client.Start();
    if (hr != 0) { err = hr.ToString("X8"); capture = null; StopClient(client); return false; }
    audioClient = client;
    wasapiOn = true;
    return true;
  }

  static bool InitPcm16(IAudioClient client, out string err) {
    err = null;
    IntPtr fmt = MakePcm16(16000, 1);
    Guid empty = Guid.Empty;
    uint flags = 0x88000000;
    int hr = client.Initialize(0, flags, 1000000, 0, fmt, ref empty);
    Marshal.FreeHGlobal(fmt);
    if (hr != 0) { err = hr.ToString("X8"); return false; }
    capRate = 16000;
    capChannels = 1;
    capBits = 16;
    capAlign = 2;
    capFloat = false;
    return true;
  }

  static bool InitMix(IAudioClient client, out string err) {
    err = null;
    IntPtr mix = IntPtr.Zero;
    int hr = client.GetMixFormat(out mix);
    if (hr != 0 || mix == IntPtr.Zero) { err = hr.ToString("X8"); return false; }
    ReadFormat(mix);
    Guid empty = Guid.Empty;
    hr = client.Initialize(0, 0, 1000000, 0, mix, ref empty);
    Marshal.FreeCoTaskMem(mix);
    if (hr != 0) { err = hr.ToString("X8"); return false; }
    return true;
  }

  static void ReadFormat(IntPtr p) {
    int tag = Marshal.ReadInt16(p, 0) & 0xffff;
    capChannels = Marshal.ReadInt16(p, 2);
    if (capChannels < 1) capChannels = 1;
    capRate = Marshal.ReadInt32(p, 4);
    if (capRate < 8000) capRate = 48000;
    capAlign = Marshal.ReadInt16(p, 12) & 0xffff;
    capBits = Marshal.ReadInt16(p, 14) & 0xffff;
    capFloat = tag == 3;
    if (tag == 0xFFFE && capBits == 32) capFloat = true;
    if (capAlign <= 0) capAlign = capChannels * Math.Max(2, capBits / 8);
  }

  static IntPtr MakePcm16(int rate, int channels) {
    IntPtr p = Marshal.AllocHGlobal(18);
    for (int i = 0; i < 18; i++) Marshal.WriteByte(p, i, 0);
    Marshal.WriteInt16(p, 0, 1);
    Marshal.WriteInt16(p, 2, (short)channels);
    Marshal.WriteInt32(p, 4, rate);
    int align = channels * 2;
    Marshal.WriteInt32(p, 8, rate * align);
    Marshal.WriteInt16(p, 12, (short)align);
    Marshal.WriteInt16(p, 14, 16);
    return p;
  }

  static bool WasapiAlive() {
    if (capture == null) return false;
    for (int i = 0; i < 25; i++) {
      uint n = 0;
      int hr = capture.GetNextPacketSize(out n);
      if (hr != 0) return false;
      if (n > 0) return true;
      Thread.Sleep(10);
    }
    return true;
  }

  static void PullWasapi(TcpClient client) {
    go = true;
    while (go && client.Connected) {
      uint n = 0;
      int hr = capture.GetNextPacketSize(out n);
      if (hr != 0) break;
      if (n == 0) { Thread.Sleep(10); continue; }
      IntPtr data;
      uint frames;
      uint flags;
      long devPos;
      long qpc;
      hr = capture.GetBuffer(out data, out frames, out flags, out devPos, out qpc);
      if (hr != 0) break;
      int bytes = (int)frames * capAlign;
      if (bytes < 0) bytes = 0;
      byte[] raw = new byte[bytes];
      if (bytes > 0 && data != IntPtr.Zero && (flags & 2) == 0) Marshal.Copy(data, raw, 0, bytes);
      capture.ReleaseBuffer(frames);
      if (bytes > 0) PushPcm(To16k(raw, (int)frames, capChannels, capRate, capBits, capFloat));
    }
  }

  static void StopClient(IAudioClient client) {
    try { if (client != null) client.Stop(); } catch {}
    try { if (client != null) client.Reset(); } catch {}
  }

  static void StopWasapi() {
    try { if (audioClient != null) audioClient.Stop(); } catch {}
    try { if (capture != null) Marshal.ReleaseComObject(capture); } catch {}
    try { if (audioClient != null) Marshal.ReleaseComObject(audioClient); } catch {}
    capture = null;
    audioClient = null;
    wasapiOn = false;
  }

  static int waveRate;
  static int waveChannels;
  static string waveName = "mic";
  static IntPtr hwi = IntPtr.Zero;
  static IntPtr[] headers;
  static GCHandle[] pins;
  static WaveInProc waveProc;
  static readonly object waveGate = new object();
  static Queue<byte[]> waveQ = new Queue<byte[]>();

  static bool TryWave(out string err) {
    err = "6";
    waveProc = OnWave;
    int n = 0;
    try { n = waveInGetNumDevs(); } catch { n = 0; }
    int[] ids = new int[n + 1];
    ids[0] = -1;
    for (int i = 0; i < n; i++) ids[i + 1] = i;
    uint[] rates = new uint[] { 44100, 48000, 16000, 22050, 11025, 8000 };
    ushort[] chs = new ushort[] { 1, 2 };
    for (int d = 0; d < ids.Length; d++) {
      string label = ids[d] < 0 ? "default" : DevName(ids[d]);
      if (ids[d] >= 0 && IsVirtual(label)) continue;
      for (int ri = 0; ri < rates.Length; ri++) {
        for (int ci = 0; ci < chs.Length; ci++) {
          int code = TryOpen(ids[d], rates[ri], chs[ci]);
          if (code == 0) {
            waveName = label;
            waveRate = (int)rates[ri];
            waveChannels = chs[ci];
            int started = waveInStart(hwi);
            if (started != 0) { CleanupWave(); err = started.ToString(); continue; }
            err = null;
            return true;
          }
          err = code.ToString();
        }
      }
    }
    return false;
  }

  static void PullWave(TcpClient client) {
    go = true;
    while (go && client.Connected) {
      byte[] frame = null;
      lock (waveGate) {
        if (waveQ.Count > 0) frame = waveQ.Dequeue();
        else Monitor.Wait(waveGate, 200);
      }
      if (frame != null) PushPcm(To16k(frame, frame.Length / Math.Max(1, waveChannels * 2), waveChannels, waveRate, 16, false));
    }
  }

  static void OnWave(IntPtr hw, uint msg, IntPtr inst, IntPtr p1, IntPtr p2) {
    if (msg != 0x3C0 || p1 == IntPtr.Zero) return;
    try {
      int recorded = Marshal.ReadInt32(p1, IntPtr.Size == 8 ? 12 : 8);
      IntPtr data = Marshal.ReadIntPtr(p1, 0);
      if (recorded > 0 && data != IntPtr.Zero) {
        byte[] copy = new byte[recorded];
        Marshal.Copy(data, copy, 0, recorded);
        lock (waveGate) { waveQ.Enqueue(copy); Monitor.Pulse(waveGate); }
      }
      waveInAddBuffer(hw, p1, Marshal.SizeOf(typeof(WAVEHDR)));
    } catch {}
  }

  static int TryOpen(int deviceId, uint sampleRate, ushort ch) {
    WAVEFORMATEX fmt = new WAVEFORMATEX();
    fmt.wFormatTag = 1;
    fmt.nChannels = ch;
    fmt.nSamplesPerSec = sampleRate;
    fmt.wBitsPerSample = 16;
    fmt.nBlockAlign = (ushort)(ch * 2);
    fmt.nAvgBytesPerSec = sampleRate * fmt.nBlockAlign;
    fmt.cbSize = 0;
    IntPtr handle;
    int err = waveInOpen(out handle, deviceId, ref fmt, waveProc, IntPtr.Zero, 0x00030000);
    if (err != 0) return err;
    hwi = handle;
    int bytes = (int)(sampleRate * fmt.nBlockAlign / 10);
    if (bytes < 640) bytes = 640;
    headers = new IntPtr[4];
    pins = new GCHandle[4];
    int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
    for (int i = 0; i < 4; i++) {
      byte[] buf = new byte[bytes];
      pins[i] = GCHandle.Alloc(buf, GCHandleType.Pinned);
      WAVEHDR hdr = new WAVEHDR();
      hdr.lpData = pins[i].AddrOfPinnedObject();
      hdr.dwBufferLength = (uint)bytes;
      IntPtr pHdr = Marshal.AllocHGlobal(hdrSize);
      Marshal.StructureToPtr(hdr, pHdr, false);
      headers[i] = pHdr;
      int pe = waveInPrepareHeader(hwi, pHdr, hdrSize);
      if (pe != 0) { CleanupWave(); return pe; }
      int ae = waveInAddBuffer(hwi, pHdr, hdrSize);
      if (ae != 0) { CleanupWave(); return ae; }
    }
    return 0;
  }

  static void CleanupWave() {
    if (hwi != IntPtr.Zero) {
      try { waveInStop(hwi); } catch {}
      try { waveInReset(hwi); } catch {}
      if (headers != null) {
        int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
        for (int i = 0; i < headers.Length; i++) {
          if (headers[i] != IntPtr.Zero) {
            try { waveInUnprepareHeader(hwi, headers[i], hdrSize); } catch {}
            Marshal.FreeHGlobal(headers[i]);
            headers[i] = IntPtr.Zero;
          }
        }
      }
      try { waveInClose(hwi); } catch {}
      hwi = IntPtr.Zero;
    }
    if (pins != null) {
      for (int i = 0; i < pins.Length; i++) {
        if (pins[i].IsAllocated) pins[i].Free();
      }
    }
    pins = null;
    headers = null;
  }

  static string DevName(int id) {
    try {
      WAVEINCAPS caps = new WAVEINCAPS();
      int n = waveInGetDevCaps(id, ref caps, Marshal.SizeOf(typeof(WAVEINCAPS)));
      if (n == 0 && !string.IsNullOrEmpty(caps.szPname)) return caps.szPname;
    } catch {}
    return "mic";
  }

  static bool IsVirtual(string s) {
    if (string.IsNullOrEmpty(s)) return false;
    string t = s.ToLowerInvariant();
    return t.IndexOf("virtual") >= 0 || t.IndexOf("voicemod") >= 0 || t.IndexOf("stereo mix") >= 0 || t.IndexOf("cable") >= 0;
  }

  static byte[] To16k(byte[] raw, int frames, int channels, int rate, int bits, bool floating) {
    if (raw == null || frames <= 0 || channels <= 0 || rate <= 0) return new byte[0];
    int bps = bits / 8;
    if (bps < 2) bps = 2;
    double ratio = (double)rate / 16000.0;
    int outFrames = (int)(frames / ratio);
    if (outFrames < 1) outFrames = 1;
    byte[] outb = new byte[outFrames * 2];
    for (int i = 0; i < outFrames; i++) {
      int start = (int)(i * ratio);
      int end = (int)((i + 1) * ratio);
      if (end <= start) end = start + 1;
      if (end > frames) end = frames;
      long sum = 0;
      int count = 0;
      for (int f = start; f < end; f++) {
        int baseOff = f * channels * bps;
        if (baseOff + bps > raw.Length) break;
        int sample = SampleAt(raw, baseOff, bps, floating);
        if (channels > 1) {
          int off2 = baseOff + bps;
          if (off2 + bps <= raw.Length) sample = (sample + SampleAt(raw, off2, bps, floating)) / 2;
        }
        sum += sample;
        count++;
      }
      short s = count == 0 ? (short)0 : (short)(sum / count);
      outb[i * 2] = (byte)(s & 255);
      outb[i * 2 + 1] = (byte)((s >> 8) & 255);
    }
    return outb;
  }

  static int SampleAt(byte[] raw, int off, int bps, bool floating) {
    if (floating && bps >= 4) {
      float f = BitConverter.ToSingle(raw, off);
      if (f > 1f) f = 1f;
      if (f < -1f) f = -1f;
      return (int)(f * 32767f);
    }
    if (bps >= 4) {
      int v = BitConverter.ToInt32(raw, off);
      return v >> 16;
    }
    if (bps == 3) {
      int v = raw[off] | (raw[off + 1] << 8) | (raw[off + 2] << 16);
      if ((v & 0x800000) != 0) v |= ~0xffffff;
      return v >> 8;
    }
    return BitConverter.ToInt16(raw, off);
  }

  [DllImport("ole32.dll")]
  static extern int CoInitializeEx(IntPtr pv, uint dwCoInit);

  [DllImport("winmm.dll")]
  static extern int waveInGetNumDevs();

  [DllImport("winmm.dll", CharSet = CharSet.Auto)]
  static extern int waveInGetDevCaps(int uDeviceID, ref WAVEINCAPS pwic, int cbwic);

  [DllImport("winmm.dll")]
  static extern int waveInOpen(out IntPtr phwi, int uDeviceID, ref WAVEFORMATEX pwfx, WaveInProc dwCallback, IntPtr dwInstance, int fdwOpen);

  [DllImport("winmm.dll")]
  static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);

  [DllImport("winmm.dll")]
  static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);

  [DllImport("winmm.dll")]
  static extern int waveInStart(IntPtr hwi);

  [DllImport("winmm.dll")]
  static extern int waveInStop(IntPtr hwi);

  [DllImport("winmm.dll")]
  static extern int waveInReset(IntPtr hwi);

  [DllImport("winmm.dll")]
  static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);

  [DllImport("winmm.dll")]
  static extern int waveInClose(IntPtr hwi);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate void WaveInProc(IntPtr hwi, uint uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  struct WAVEFORMATEX {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct WAVEHDR {
    public IntPtr lpData;
    public uint dwBufferLength;
    public uint dwBytesRecorded;
    public IntPtr dwUser;
    public uint dwFlags;
    public uint dwLoops;
    public IntPtr lpNext;
    public IntPtr reserved;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  struct WAVEINCAPS {
    public ushort wMid;
    public ushort wPid;
    public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szPname;
    public uint dwFormats;
    public ushort wChannels;
    public ushort wReserved1;
  }
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorCom {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
  [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, ref Guid audioSessionGuid);
  [PreserveSig] int GetBufferSize(out uint numBufferFrames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
  [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr eventHandle);
  [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint numFrames, out uint flags, out long devicePosition, out long qpcPosition);
  [PreserveSig] int ReleaseBuffer(uint numFrames);
  [PreserveSig] int GetNextPacketSize(out uint numFrames);
}
