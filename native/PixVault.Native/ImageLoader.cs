using System.IO;
using System.Windows.Media.Imaging;

namespace PixVault.Native;

public static class ImageLoader
{
    public static BitmapImage Decode(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        var header = BitmapDecoder.Create(stream, BitmapCreateOptions.DelayCreation, BitmapCacheOption.None).Frames[0];
        if ((long)header.PixelWidth * header.PixelHeight > 100_000_000 || header.PixelWidth <= 0 || header.PixelHeight <= 0)
            throw new InvalidDataException("画像の画素数が上限を超えています。");
        int width = header.PixelWidth, height = header.PixelHeight;
        stream.Position = 0;
        var bitmap = new BitmapImage();
        bitmap.BeginInit();
        bitmap.CacheOption = BitmapCacheOption.OnLoad;
        bitmap.StreamSource = stream;
        if (width >= height) bitmap.DecodePixelWidth = Math.Min(width, 2560);
        else bitmap.DecodePixelHeight = Math.Min(height, 2560);
        bitmap.EndInit();
        bitmap.Freeze();
        return bitmap;
    }
}
