// resample.cs — re-muestreo de iconos sin ringing (box average separable,
// luz lineal alfa-premultiplicada). Usado por generate-app-icons.ps1.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

public class IconResample {
  public class Img {
    public int W; public int H;
    public double[] PR; public double[] PG; public double[] PB; public double[] A;
  }

  static double S2L(double v) {
    v /= 255.0;
    return v <= 0.04045 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4);
  }

  static double L2S(double v) {
    if (v < 0) v = 0; if (v > 1) v = 1;
    double s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.Pow(v, 1.0 / 2.4) - 0.055;
    if (s < 0) s = 0; if (s > 1) s = 1;
    return s * 255.0 + 0.5;
  }

  public static Img FromFile(string path) {
    using (Bitmap src = new Bitmap(path)) {
      int w = src.Width, h = src.Height;
      using (Bitmap argb = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        using (Graphics g = Graphics.FromImage(argb)) {
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
          g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
          g.DrawImage(src, 0, 0, w, h);
        }
        return FromBitmap(argb);
      }
    }
  }

  static Img FromBitmap(Bitmap bmp) {
    Img img = new Img();
    img.W = bmp.Width; img.H = bmp.Height;
    int n = img.W * img.H;
    img.PR = new double[n]; img.PG = new double[n];
    img.PB = new double[n]; img.A = new double[n];
    Rectangle rect = new Rectangle(0, 0, img.W, img.H);
    BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    byte[] buf = new byte[Math.Abs(data.Stride) * img.H];
    System.Runtime.InteropServices.Marshal.Copy(data.Scan0, buf, 0, buf.Length);
    bmp.UnlockBits(data);
    for (int y = 0; y < img.H; y++) {
      int sp = y * data.Stride;
      for (int x = 0; x < img.W; x++) {
        int p = sp + x * 4;
        double a = buf[p + 3] / 255.0;
        double r = S2L(buf[p + 2]) * a; // premultiplied linear
        double gg = S2L(buf[p + 1]) * a;
        double b = S2L(buf[p]) * a;
        int i = y * img.W + x;
        img.A[i] = a; img.PR[i] = r; img.PG[i] = gg; img.PB[i] = b;
      }
    }
    return img;
  }

  // Downsample vertical ponderado (box separable): bandas de ancho sy, suma de
  // pesos = 1 -> promedio de area exacto en luz lineal alfa-premultiplicada.
  static Img VDown(Img s, int th) {
    Img o = new Img();
    o.W = s.W; o.H = th;
    int n = o.W * o.H;
    o.PR = new double[n]; o.PG = new double[n];
    o.PB = new double[n]; o.A = new double[n];
    double sy = (double)s.H / th;
    for (int oy = 0; oy < th; oy++) {
      double y0 = oy * sy, y1 = y0 + sy;
      int iy0 = (int)Math.Floor(y0), iy1 = (int)Math.Ceiling(y1);
      if (iy1 > s.H) iy1 = s.H;
      for (int iy = iy0; iy < iy1; iy++) {
        double wy = Math.Min(iy + 1, y1) - Math.Max(iy, y0);
        if (wy <= 0) continue;
        int si = iy * s.W, di = oy * o.W;
        for (int x = 0; x < o.W; x++) {
          o.PR[di + x] += s.PR[si + x] * wy;
          o.PG[di + x] += s.PG[si + x] * wy;
          o.PB[di + x] += s.PB[si + x] * wy;
          o.A[di + x] += s.A[si + x] * wy;
        }
      }
    }
    return o;
  }

  static Img HDown(Img s, int tw) {
    Img o = new Img();
    o.W = tw; o.H = s.H;
    int n = o.W * o.H;
    o.PR = new double[n]; o.PG = new double[n];
    o.PB = new double[n]; o.A = new double[n];
    double sx = (double)s.W / tw;
    for (int y = 0; y < o.H; y++) {
      int si = y * s.W, di = y * o.W;
      for (int ox = 0; ox < tw; ox++) {
        double x0 = ox * sx, x1 = x0 + sx;
        int ix0 = (int)Math.Floor(x0), ix1 = (int)Math.Ceiling(x1);
        if (ix1 > s.W) ix1 = s.W;
        double pr = 0, pg = 0, pb = 0, aa = 0;
        for (int ix = ix0; ix < ix1; ix++) {
          double wx = Math.Min(ix + 1, x1) - Math.Max(ix, x0);
          if (wx <= 0) continue;
          int i = si + ix;
          pr += s.PR[i] * wx; pg += s.PG[i] * wx;
          pb += s.PB[i] * wx; aa += s.A[i] * wx;
        }
        int d = di + ox;
        o.PR[d] = pr; o.PG[d] = pg; o.PB[d] = pb; o.A[d] = aa;
      }
    }
    return o;
  }

  public static Img Box(Img s, int tw, int th) {
    return HDown(VDown(s, th), tw);
  }

  public static byte[] ToPng(Img img) {
    using (Bitmap bmp = new Bitmap(img.W, img.H, PixelFormat.Format32bppArgb)) {
      Rectangle rect = new Rectangle(0, 0, img.W, img.H);
      BitmapData data = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      byte[] buf = new byte[Math.Abs(data.Stride) * img.H];
      for (int y = 0; y < img.H; y++) {
        int sp = y * data.Stride;
        for (int x = 0; x < img.W; x++) {
          int i = y * img.W + x;
          int p = sp + x * 4;
          double a = img.A[i];
          if (a < 1e-6) { buf[p] = 0; buf[p + 1] = 0; buf[p + 2] = 0; buf[p + 3] = 0; continue; }
          double inv = 1.0 / a;
          buf[p] = (byte)L2S(img.PB[i] * inv);
          buf[p + 1] = (byte)L2S(img.PG[i] * inv);
          buf[p + 2] = (byte)L2S(img.PR[i] * inv);
          buf[p + 3] = (byte)Math.Min(255, a * 255.0 + 0.5);
        }
      }
      System.Runtime.InteropServices.Marshal.Copy(buf, 0, data.Scan0, buf.Length);
      bmp.UnlockBits(data);
      using (MemoryStream ms = new MemoryStream()) {
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
      }
    }
  }

  public static void SavePng(string path, Img img) {
    File.WriteAllBytes(path, ToPng(img));
  }
}
