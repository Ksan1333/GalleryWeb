using System.IO.Compression;
using PixVault.Core;

int passed = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL: " + name);
    Console.WriteLine("PASS: " + name); passed++;
}
string fixture = Path.Combine(Path.GetTempPath(), "pixvault-native-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(fixture);
try
{
    Check(new[] { "10.png", "2.png", "1.png" }.OrderBy(x => x, NaturalPathComparer.Instance).SequenceEqual(["1.png", "2.png", "10.png"]), "natural ordering");
    Check(NaturalPathComparer.Instance.Compare("10000000000000000000.png", "9.png") > 0, "large numbers do not overflow");
    Check(ReaderFiles.NextIndex(0, 3, -1) == 0 && ReaderFiles.NextIndex(2, 3, 1) == 2, "file boundaries do not wrap");
    Check(ReaderFiles.VisiblePages(0, 3, true, true).SequenceEqual([1, 0]), "right-bound spread");
    Check(ReaderFiles.VisiblePages(2, 3, true, true).SequenceEqual([2]), "odd final page");
    Check(ReaderFiles.VisiblePages(1, 3, false, true).SequenceEqual([1]), "single page");
    Check(ReaderFiles.Zoom(4, 120) == 4 && ReaderFiles.Zoom(.25, -120) == .25 && ReaderFiles.Zoom(1, 0) == 1, "zoom limits");
    string book = Path.Combine(fixture, "book.cbz");
    using (var zip = ZipFile.Open(book, ZipArchiveMode.Create))
    {
        foreach (string name in new[] { "10.png", "2.png", "1.png", "notes.txt" })
        { using var writer = new StreamWriter(zip.CreateEntry(name).Open()); writer.Write(name); }
    }
    using (var document = new ReaderDocument(book))
    {
        Check(document.PageCount == 3, "non-image entries excluded");
        Check(System.Text.Encoding.UTF8.GetString(document.ReadPage(1)) == "2.png", "archive page order and bytes");
        bool rejected = false;
        try { document.ReadPage(3); } catch (ArgumentOutOfRangeException) { rejected = true; }
        Check(rejected, "invalid page rejected");
    }
    using (File.Open(book, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { Check(true, "archive handles released"); }
    string settings = Path.Combine(fixture, "settings.json");
    new ReaderSettings(false, false, false).Save(settings);
    Check(ReaderSettings.Load(settings) == new ReaderSettings(false, false, false), "settings round trip");
    File.WriteAllText(settings, "broken json");
    Check(ReaderSettings.Load(settings) == new ReaderSettings(), "corrupt settings fallback");
    string huge = Path.Combine(fixture, "huge.png");
    using (var file = File.Create(huge)) file.SetLength(ReaderFiles.MaxPageBytes + 1L);
    using (var document = new ReaderDocument(huge))
    {
        bool rejected = false;
        try { document.ReadPage(0); } catch (InvalidDataException) { rejected = true; }
        Check(rejected, "oversized image rejected before allocation");
    }
    Check(ReaderFiles.Neighbors(book).Length == 2, "folder enumeration excludes unsupported files");
    Console.WriteLine($"{passed} tests passed. No windows created.");
}
finally { Directory.Delete(fixture, true); }
