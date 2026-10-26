using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using PixVault.Native;

// WIC decoding only: no Application, Window, GUI automation or screenshots.
foreach (var (width, height) in new[] { (12, 8), (3000, 1), (1, 3000) })
{
    var source = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgr24, null, new byte[width * height * 3], width * 3);
    var encoder = new PngBitmapEncoder();
    encoder.Frames.Add(BitmapFrame.Create(source));
    using var stream = new MemoryStream();
    encoder.Save(stream);
    var result = ImageLoader.Decode(stream.ToArray());
    if (!result.IsFrozen || result.PixelWidth > 2560 || result.PixelHeight > 2560) throw new Exception("decode bounds/freeze failed");
    byte[] pixels = new byte[result.PixelWidth * result.PixelHeight * 4];
    result.CopyPixels(pixels, result.PixelWidth * 4, 0);
    Console.WriteLine($"PASS: {width}x{height} decoded, bounded and retained after stream disposal");
}
bool rejected = false;
try { ImageLoader.Decode([1, 2, 3]); }
catch (Exception ex) when (ex is NotSupportedException or FileFormatException or System.Runtime.InteropServices.COMException) { rejected = true; }
if (!rejected) throw new Exception("invalid image not rejected");
Console.WriteLine("PASS: corrupt image rejected. 4 imaging tests passed. No windows created.");
