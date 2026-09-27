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
  static int waveRate;
  static int waveChannels;
  static string waveName = "mic";
  static IntPtr hwi = IntPtr.Zero;
  static IntPtr[] headers;
  static GCHandle[] pins;
  static WaveInProc waveProc;
  static readonly object waveGate = new object();
  static Queue<byte[]> waveQ = new Queue<byte[]>();

  public static void Main(string[] args) {
    int port = 0;
    if (args.Length > 0) int.TryParse(args[0], out port);
    if (port > 0) Run(port);
  }

  public static void Run(int port) {
    TcpClient client = Connect(port);
    if (client == null) return;
    ns = client.GetStream();
    try {
      string err;
      if (!TryWave(out err)) {
        SendText("FAIL\t" + (err ?? "6") + "\twave");
        return;
      }
      SendText("READY\twave\t" + Safe(waveName) + "\t" + waveRate + "\t" + waveChannels);
      PullWave(client);
    } catch (Exception ex) {
      try { SendText("FAIL\t0\t" + Safe(ex.Message)); } catch {}
    } finally {
      go = false;
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

  static bool TryWave(out string err) {
    err = "6";
    waveProc = OnWave;
    int count = 0;
    try { count = waveInGetNumDevs(); } catch { count = 0; }
    int[] ids = new int[count + 1];
    ids[0] = -1;
    for (int i = 0; i < count; i++) ids[i + 1] = i;
    uint[] rates = new uint[] { 44100, 48000, 16000, 22050, 11025, 8000 };
    ushort[] chs = new ushort[] { 1, 2 };
    for (int pass = 0; pass < 2; pass++) {
      for (int d = 0; d < ids.Length; d++) {
        string label = ids[d] < 0 ? "default" : DevName(ids[d]);
        bool virt = ids[d] >= 0 && IsVirtual(label);
        if (pass == 0 && virt) continue;
        if (pass == 1 && !virt) continue;
        for (int ri = 0; ri < rates.Length; ri++) {
          for (int ci = 0; ci < chs.Length; ci++) {
            int code = TryOpen(ids[d], rates[ri], chs[ci]);
            if (code != 0) { err = code.ToString(); continue; }
            int started = waveInStart(hwi);
            if (started != 0) { CleanupWave(); err = started.ToString(); continue; }
            waveName = label;
            waveRate = (int)rates[ri];
            waveChannels = chs[ci];
            err = null;
            return true;
          }
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
      if (frame != null) {
        int ch = waveChannels < 1 ? 1 : waveChannels;
        PushPcm(To16k(frame, frame.Length / (ch * 2), ch, waveRate));
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

  static byte[] To16k(byte[] raw, int frames, int channels, int rate) {
    if (raw == null || frames <= 0 || channels <= 0 || rate <= 0) return new byte[0];
    int bps = 2;
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
        if (off + 1 >= raw.Length) break;
        int sample = BitConverter.ToInt16(raw, off);
        if (channels > 1 && off + 3 < raw.Length) sample = (sample + BitConverter.ToInt16(raw, off + 2)) / 2;
        sum += sample;
        count++;
      }
      short s = count == 0 ? (short)0 : (short)(sum / count);
      outb[i * 2] = (byte)(s & 255);
      outb[i * 2 + 1] = (byte)((s >> 8) & 255);
    }
    return outb;
  }

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
