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
  static int capRate = 48000;
  static int capChannels = 2;
  static int capBits = 32;
  static int capAlign = 8;
  static bool capFloat = true;
  static IAudioClient audioClient;
  static IAudioCaptureClient capture;

  public static void Run(int port) {
    Capture(port);
  }

  static void Capture(int port) {
    if (port <= 0) return;
    try { CoInitializeEx(IntPtr.Zero, 0); } catch {}
    TcpClient client = Connect(port);
    if (client == null) return;
    ns = client.GetStream();
    try {
      RelaxCaptureDevices();
      Thread.Sleep(300);
      string wasapi = null;
      string wave = null;
      if (TryWasapi(out wasapi)) {
        SendText("READY\twasapi\tdefault\t16000\t1");
        PullWasapi(client);
        return;
      }
      if (TryWave(out wave)) {
        SendText("READY\twave\tdefault\t16000\t1");
        PullWave(client);
        return;
      }
      SendText("FAIL\t" + (wasapi ?? wave ?? "1") + "\topen");
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

  static void RelaxCaptureDevices() {
    try {
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      IMMDeviceCollection list = null;
      int hr = en.EnumAudioEndpoints(1, 1, out list);
      if (hr != 0 || list == null) return;
      uint n = 0;
      list.GetCount(out n);
      for (uint i = 0; i < n && i < 8; i++) {
        IMMDevice dev = null;
        if (list.Item(i, out dev) == 0 && dev != null) Relax(dev);
      }
      IMMDevice def = null;
      if (en.GetDefaultAudioEndpoint(1, 0, out def) == 0 && def != null) Relax(def);
    } catch {}
  }

  static void Relax(IMMDevice dev) {
    try {
      IPropertyStore store = null;
      if (dev.OpenPropertyStore(2, out store) != 0 || store == null) return;
      SetDword(store, "B3F8FA53-0004-438E-9003-51A46E139BFC", 3, 0);
      SetDword(store, "B3F8FA53-0004-438E-9003-51A46E139BFC", 4, 0);
      SetDword(store, "1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E", 5, 1);
      store.Commit();
    } catch {}
  }

  static void SetDword(IPropertyStore store, string guid, uint pid, uint value) {
    PROPERTYKEY key = new PROPERTYKEY();
    key.fmtid = new Guid(guid);
    key.pid = pid;
    PROPVARIANT pv = new PROPVARIANT();
    pv.vt = 19;
    pv.ulVal = value;
    store.SetValue(ref key, ref pv);
  }

  static bool TryWasapi(out string err) {
    err = "1";
    try {
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      int[] roles = new int[] { 0, 2, 1 };
      for (int r = 0; r < roles.Length; r++) {
        IMMDevice dev = null;
        int hr = en.GetDefaultAudioEndpoint(1, roles[r], out dev);
        if (hr != 0 || dev == null) { err = hr.ToString("X8"); continue; }
        string one;
        if (OpenClient(dev, true, out one)) return true;
        err = one;
        if (OpenClient(dev, false, out one)) return true;
        err = one;
      }
    } catch (Exception ex) {
      err = Safe(ex.Message);
    }
    return false;
  }

  static bool OpenClient(IMMDevice dev, bool mix, out string err) {
    err = "1";
    Guid iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    object obj = null;
    int hr = dev.Activate(ref iid, 23, IntPtr.Zero, out obj);
    if (hr != 0 || obj == null) { err = hr.ToString("X8"); return false; }
    IAudioClient client = (IAudioClient)obj;
    bool ready = mix ? InitMix(client, out err) : InitPcm16(client, out err);
    if (!ready) { StopClient(client); return false; }
    Guid capId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    object capObj = null;
    hr = client.GetService(ref capId, out capObj);
    if (hr != 0 || capObj == null) { err = hr.ToString("X8"); StopClient(client); return false; }
    capture = (IAudioCaptureClient)capObj;
    hr = client.Start();
    if (hr != 0) { err = hr.ToString("X8"); capture = null; StopClient(client); return false; }
    audioClient = client;
    return true;
  }

  static bool InitMix(IAudioClient client, out string err) {
    err = null;
    IntPtr mix = IntPtr.Zero;
    int hr = client.GetMixFormat(out mix);
    if (hr != 0 || mix == IntPtr.Zero) { err = hr.ToString("X8"); return false; }
    ReadFormat(mix);
    Guid empty = Guid.Empty;
    hr = client.Initialize(0, 0, 0, 0, mix, ref empty);
    Marshal.FreeCoTaskMem(mix);
    if (hr != 0) { err = hr.ToString("X8"); return false; }
    return true;
  }

  static bool InitPcm16(IAudioClient client, out string err) {
    err = null;
    IntPtr fmt = MakePcm16(16000, 1);
    Guid empty = Guid.Empty;
    int hr = client.Initialize(0, 0x88000000, 0, 0, fmt, ref empty);
    Marshal.FreeHGlobal(fmt);
    if (hr != 0) { err = hr.ToString("X8"); return false; }
    capRate = 16000;
    capChannels = 1;
    capBits = 16;
    capAlign = 2;
    capFloat = false;
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
    capFloat = tag == 3 || (tag == 0xFFFE && capBits == 32);
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
      try {
        if (bytes > 0) PushPcm(To16k(raw, (int)frames, capChannels, capRate, capBits, capFloat));
      } catch {}
    }
  }

  static void StopClient(IAudioClient client) {
    try { if (client != null) client.Stop(); } catch {}
    try { if (client != null) Marshal.ReleaseComObject(client); } catch {}
  }

  static void StopWasapi() {
    try { if (audioClient != null) audioClient.Stop(); } catch {}
    try { if (capture != null) Marshal.ReleaseComObject(capture); } catch {}
    try { if (audioClient != null) Marshal.ReleaseComObject(audioClient); } catch {}
    capture = null;
    audioClient = null;
  }

  static int waveRate;
  static int waveChannels = 1;
  static IntPtr hwi = IntPtr.Zero;
  static IntPtr[] headers;
  static GCHandle[] pins;
  static WaveInProc waveProc;
  static readonly object waveGate = new object();
  static Queue<byte[]> waveQ = new Queue<byte[]>();

  static bool TryWave(out string err) {
    err = "1";
    waveProc = OnWave;
    uint[] rates = new uint[] { 48000, 44100, 16000 };
    ushort[] chs = new ushort[] { 2, 1 };
    for (int ri = 0; ri < rates.Length; ri++) {
      for (int ci = 0; ci < chs.Length; ci++) {
        int code = TryOpen(-1, rates[ri], chs[ci]);
        if (code != 0) { err = code.ToString(); continue; }
        int started = waveInStart(hwi);
        if (started != 0) { CleanupWave(); err = started.ToString(); continue; }
        waveRate = (int)rates[ri];
        waveChannels = chs[ci];
        err = null;
        return true;
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
      if (frame != null) {
        int ch = waveChannels < 1 ? 1 : waveChannels;
        PushPcm(To16k(frame, frame.Length / (ch * 2), ch, waveRate, 16, false));
      }
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
    int openErr = waveInOpen(out handle, deviceId, ref fmt, waveProc, IntPtr.Zero, 0x00030000);
    if (openErr != 0) return openErr;
    hwi = handle;
    int bytes = (int)(sampleRate * fmt.nBlockAlign / 10);
    if (bytes < 640) bytes = 640;
    headers = new IntPtr[3];
    pins = new GCHandle[3];
    int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
    for (int i = 0; i < 3; i++) {
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
          }
        }
      }
      try { waveInClose(hwi); } catch {}
      hwi = IntPtr.Zero;
    }
    if (pins != null) {
      for (int i = 0; i < pins.Length; i++) if (pins[i].IsAllocated) pins[i].Free();
    }
    pins = null;
    headers = null;
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
        int off = f * channels * bps;
        if (off + bps > raw.Length) break;
        int sample = SampleAt(raw, off, bps, floating);
        if (channels > 1) {
          int off2 = off + bps;
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
    if (bps >= 4) return BitConverter.ToInt32(raw, off) >> 16;
    return BitConverter.ToInt16(raw, off);
  }

  [DllImport("ole32.dll")]
  static extern int CoInitializeEx(IntPtr pv, uint dwCoInit);

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

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPVARIANT {
    public ushort vt;
    public ushort r1;
    public ushort r2;
    public ushort r3;
    public uint ulVal;
    public uint pad0;
    public uint pad1;
    public uint pad2;
  }
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorCom {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out CbopkaMic.PROPERTYKEY key);
  [PreserveSig] int GetValue(ref CbopkaMic.PROPERTYKEY key, out CbopkaMic.PROPVARIANT value);
  [PreserveSig] int SetValue(ref CbopkaMic.PROPERTYKEY key, ref CbopkaMic.PROPVARIANT value);
  [PreserveSig] int Commit();
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
  [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, ref Guid sessionGuid);
  [PreserveSig] int GetBufferSize(out uint frames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint padding);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long def, out long min);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr handle);
  [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out long devPos, out long qpc);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}
