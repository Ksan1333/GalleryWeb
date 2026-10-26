using System.IO.Compression;
using System.Text.Json;

namespace PixVault.Core;

public sealed class NaturalPathComparer : IComparer<string>
{
    public static readonly NaturalPathComparer Instance = new();
    public int Compare(string? x, string? y)
    {
        if (x is null || y is null) return StringComparer.OrdinalIgnoreCase.Compare(x, y);
        int a = 0, b = 0;
        while (a < x.Length && b < y.Length)
        {
            if (char.IsAsciiDigit(x[a]) && char.IsAsciiDigit(y[b]))
            {
                int startA = a, startB = b;
                while (a < x.Length && char.IsAsciiDigit(x[a])) a++;
                while (b < y.Length && char.IsAsciiDigit(y[b])) b++;
                var digitsA = x.AsSpan(startA, a - startA).TrimStart('0');
                var digitsB = y.AsSpan(startB, b - startB).TrimStart('0');
                int number = digitsA.Length.CompareTo(digitsB.Length);
                if (number == 0) number = digitsA.SequenceCompareTo(digitsB);
                if (number != 0) return number;
            }
            else
            {
                int letter = char.ToUpperInvariant(x[a++]).CompareTo(char.ToUpperInvariant(y[b++]));
                if (letter != 0) return letter;
            }
        }
        int remaining = (x.Length - a).CompareTo(y.Length - b);
        return remaining != 0 ? remaining : StringComparer.Ordinal.Compare(x, y);
    }
}

public static class ReaderFiles
{
    public const int MaxPageBytes = 64 * 1024 * 1024;
    public static bool IsImage(string path) => Path.GetExtension(path).ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" or ".bmp" or ".gif";
    public static bool IsBook(string path) => Path.GetExtension(path).ToLowerInvariant() is ".zip" or ".cbz";
    public static string[] Neighbors(string path) => Directory.EnumerateFiles(Path.GetDirectoryName(Path.GetFullPath(path))!)
        .Where(p => IsImage(p) || IsBook(p)).OrderBy(p => p, NaturalPathComparer.Instance).ToArray();
    public static int NextIndex(int index, int count, int direction) => count == 0 ? 0 : Math.Clamp(index + direction, 0, count - 1);
    public static double Zoom(double current, int wheelDelta) => wheelDelta == 0 ? current : Math.Clamp(current * (wheelDelta > 0 ? 1.2 : 1 / 1.2), .25, 4);
    public static int[] VisiblePages(int index, int count, bool spread, bool rightBinding)
    {
        if (count == 0) return [];
        index = Math.Clamp(index, 0, count - 1);
        int start = spread ? index / 2 * 2 : index;
        var pages = spread && start + 1 < count ? new[] { start, start + 1 } : [start];
        if (rightBinding) Array.Reverse(pages);
        return pages;
    }
}

// Open only the selected file. ZIP entries are read in memory, never extracted.
public sealed class ReaderDocument : IDisposable
{
    private readonly ZipArchive? archive;
    private readonly ZipArchiveEntry[] entries;
    public string Path { get; }
    public int PageCount => archive is null ? 1 : entries.Length;
    public ReaderDocument(string path)
    {
        Path = System.IO.Path.GetFullPath(path);
        entries = [];
        if (ReaderFiles.IsBook(path))
        {
            archive = ZipFile.OpenRead(Path);
            try
            {
                entries = archive.Entries.Where(e => e.Name.Length > 0 && ReaderFiles.IsImage(e.FullName))
                    .OrderBy(e => e.FullName, NaturalPathComparer.Instance).ToArray();
                if (entries.Length == 0) throw new InvalidDataException("この本には対応する画像がありません。");
                if (entries.Length > 20000) throw new InvalidDataException("ページ数が上限（20,000）を超えています。");
            }
            catch { archive.Dispose(); throw; }
        }
        else if (!ReaderFiles.IsImage(path)) throw new NotSupportedException("画像またはZIP/CBZを選択してください。");
    }
    public byte[] ReadPage(int index)
    {
        if (index < 0 || index >= PageCount) throw new ArgumentOutOfRangeException(nameof(index));
        long length = archive is null ? new FileInfo(Path).Length : entries[index].Length;
        if (length > ReaderFiles.MaxPageBytes) throw new InvalidDataException("1ページの上限は64MiBです。");
        using Stream input = archive is null ? File.OpenRead(Path) : entries[index].Open();
        using var output = new MemoryStream();
        byte[] buffer = new byte[81920];
        int read;
        while ((read = input.Read(buffer)) > 0)
        {
            if (output.Length + read > ReaderFiles.MaxPageBytes) throw new InvalidDataException("ページが大きすぎます。");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }
    public void Dispose() => archive?.Dispose();
}

public sealed record ReaderSettings(bool Spread = true, bool RightBinding = true, bool NeeView = true)
{
    public static ReaderSettings Load(string path)
    {
        try { return JsonSerializer.Deserialize<ReaderSettings>(File.ReadAllText(path)) ?? new(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }
    public void Save(string path)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, JsonSerializer.Serialize(this)); File.Move(temporary, path, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
