<#@ script language="cs" #>
<#@ assembly name="System.Drawing" #>
<#@ import namespace="System" #>
<#@ import namespace="System.IO" #>
<#@ import namespace="System.Drawing" #>
<#@ import namespace="System.Drawing.Imaging" #>
// Logo prep for paste-1792487130466-122664.png only: square 600x600, scaled
// to fit, centred on transparent. Other files are copied as-is for reference.

string SrcDir = @"C:\Users\SAKAR\AppData\Local\Temp\freebuff-desktop-pastes";
string RefDir = "src/server/public/logos";
string DstDir = Path.Combine(Directory.GetCurrentDirectory(), "output", "_logo-fix");

Directory.CreateDirectory(DstDir);

string Paste2 = Path.Combine(SrcDir, "paste-1792487130466-122664.png");

// ---- square logo variant ----
{
  int boxW = 600, boxH = 600;
  if (!File.Exists(Paste2)) { Console.WriteLine("MISSING " + Paste2); }
  else {
    using (var img = Image.FromFile(Paste2)) {
      int w = img.Width, h = img.Height;
      int scale = Math.Max(1, Math.Min(w / boxW, h / boxH));
      int srcW = Math.Max(boxW, w / scale);
      int srcH = Math.Max(boxH, h / scale);
      float scaleF = (float)srcW / w;
      int fitW = (int)Math.Round(w * scaleF);
      int fitH = (int)Math.Round(h * scaleF);

      using (var bmp = new Bitmap(boxW, boxH, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.Clear(Color.Transparent);
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
          int dx = (boxW - fitW) / 2;
          int dy = (boxH - fitH) / 2;
          g.DrawImage(img, new Rectangle(dx, dy, fitW, fitH), 0, 0, w, h, GraphicsUnit.Pixel);
        }
        bmp.Save(Path.Combine(DstDir, "paste-1792487130466-122664-square.png"), ImageFormat.Png);
      }
    }
  }
}

// ---- reference copies (original bytes) ----
foreach (var f in new[] {
  Path.Combine(SrcDir, "paste-1792487107068-122664.png"),
  Path.Combine(SrcDir, "paste-1792487130466-122664.png"),
  Path.Combine(RefDir, "sakar.png")
}) {
  if (!File.Exists(f)) { Console.WriteLine("MISSING " + f); continue; }
  File.Copy(f, Path.Combine(DstDir, Path.GetFileName(f)), true);
}

foreach (var f in Directory.GetFiles(DstDir)) {
  var st = new FileInfo(f);
  Console.WriteLine(st.Name + " " + st.Length);
}
