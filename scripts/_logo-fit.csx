<#@ script language="cs" #>
<#@ assembly name="System.Drawing" #>
<#@ import namespace="System" #>
<#@ import namespace="System.IO" #>
<#@ import namespace="System.Drawing" #>
<#@ import namespace="System.Drawing.Imaging" #>
// Logo fit helper: place a source PNG into a fixed box, preserve aspect,
// pad with transparent, write a clean 24-bit PNG. Pure .NET, no npm deps.

string SrcDir = @"C:\Users\SAKAR\AppData\Local\Temp\freebuff-desktop-pastes";
string DstDir = Path.Combine(Directory.GetCurrentDirectory(), "output", "_logo-fit");

Directory.CreateDirectory(DstDir);

int BoxW = 400;   // target box width
int BoxH = 160;   // target box height

void SaveFit(string src, string dst, int boxW, int boxH) {
  if (!File.Exists(src)) { Console.WriteLine("MISSING " + src); return; }
  using (var img = Image.FromFile(src)) {
    int w = img.Width, h = img.Height;
    // Only downscale, never upscale, and never make the whole thing tiny.
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
        g.DrawImage(img, new Rectangle(dx, dy, fitW, fitH),
                    0, 0, w, h, GraphicsUnit.Pixel);
      }
      bmp.Save(dst, ImageFormat.Png);
    }
  }
  var st = new FileInfo(dst);
  Console.WriteLine(dst + " W=" + boxW + " H=" + boxH + " size=" + st.Length);
}

string[] files = {
  Path.Combine(SrcDir, "paste-1792487107068-122664.png"),
  Path.Combine(SrcDir, "paste-1792487130466-122664.png"),
};
foreach (var f in files) {
  string name = Path.GetFileNameWithoutExtension(f);
  SaveFit(f, Path.Combine(DstDir, name + "-fit.png"), BoxW, BoxH);
}
