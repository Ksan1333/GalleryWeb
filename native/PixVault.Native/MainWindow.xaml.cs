using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;
using PixVault.Core;

namespace PixVault.Native;
public partial class MainWindow : Window
{
    private readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PixVault.Native", "reader-settings.json");
    private ReaderSettings settings;
    private string[] files = [];
    private string? currentPath;
    private int pageIndex, pageCount, generation;
    private bool updatingSlider;
    private double zoom = 1;
    private long lastWheel = -1000;
    private readonly SemaphoreSlim decodeGate = new(1, 1);

    public MainWindow()
    {
        InitializeComponent();
        settings = ReaderSettings.Load(settingsPath);
        SpreadOption.IsChecked = settings.Spread;
        BindingOption.IsChecked = settings.RightBinding;
        AppearanceOption.IsChecked = settings.NeeView;
        ApplyAppearance();
        Closed += (_, _) => generation++;
    }

    public async Task OpenAsync(string path)
    {
        int request = ++generation;
        try
        {
            path = Path.GetFullPath(path);
            var result = await Task.Run(() =>
            {
                using var document = new ReaderDocument(path);
                return (Files: ReaderFiles.Neighbors(path), Count: document.PageCount);
            });
            if (request != generation) return;
            files = result.Files;
            currentPath = path;
            pageIndex = 0;
            pageCount = result.Count;
            zoom = 1;
            Title = $"{Path.GetFileName(path)} — PixVault Native Preview";
            await RenderAsync();
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        { if (request == generation) Status.Text = $"開けませんでした: {ex.Message}"; }
    }

    private async Task RenderAsync()
    {
        if (currentPath is null) return;
        int request = ++generation;
        string path = currentPath;
        var visible = ReaderFiles.VisiblePages(pageIndex, pageCount, settings.Spread, settings.RightBinding);
        Status.Text = "読み込み中…";
        try
        {
            BitmapImage[] bitmaps;
            await decodeGate.WaitAsync();
            try
            {
                if (request != generation) return;
                bitmaps = await Task.Run(() =>
                {
                    using var document = new ReaderDocument(path);
                    return visible.Select(index => ImageLoader.Decode(document.ReadPage(index))).ToArray();
                });
            }
            finally { decodeGate.Release(); }
            if (request != generation) return;
            LeftPage.Source = bitmaps.ElementAtOrDefault(0);
            RightPage.Source = bitmaps.ElementAtOrDefault(1);
            RightPage.Visibility = bitmaps.Length > 1 ? Visibility.Visible : Visibility.Collapsed;
            updatingSlider = true;
            PageSlider.Maximum = pageCount;
            PageSlider.Value = pageIndex + 1;
            PageSlider.IsDirectionReversed = settings.RightBinding;
            updatingSlider = false;
            PageLabel.Text = $"{pageIndex + 1} / {pageCount}";
            FitPages();
            Viewport.ScrollToHome();
            Status.Text = $"{Path.GetFileName(path)}　ホイール：前後のファイル ／ Ctrl＋ホイール：ズーム ／ ← →：ページ";
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or FileFormatException or UnauthorizedAccessException or NotSupportedException or ArgumentException or System.Runtime.InteropServices.COMException)
        { if (request == generation) { LeftPage.Source = RightPage.Source = null; Status.Text = $"表示できませんでした: {ex.Message}"; } }
    }

    private void FitPages()
    {
        if (LeftPage.Source is not BitmapSource left) return;
        var right = RightPage.Source as BitmapSource;
        double availableWidth = Math.Max(1, Viewport.ActualWidth - 40);
        double availableHeight = Math.Max(1, Viewport.ActualHeight - 40);
        double scale = Math.Min(availableWidth / (left.PixelWidth + (right?.PixelWidth ?? 0)), availableHeight / Math.Max(left.PixelHeight, right?.PixelHeight ?? 0));
        LeftPage.Width = left.PixelWidth * scale; LeftPage.Height = left.PixelHeight * scale;
        RightPage.Width = (right?.PixelWidth ?? 0) * scale; RightPage.Height = (right?.PixelHeight ?? 0) * scale;
        ZoomTransform.ScaleX = ZoomTransform.ScaleY = zoom;
        ZoomButton.Content = $"{zoom:P0}";
    }
    private void ApplyAppearance()
    {
        Viewport.Background = new SolidColorBrush(settings.NeeView ? Color.FromRgb(22, 22, 22) : Color.FromRgb(40, 34, 52));
        Pages.Margin = new Thickness(settings.NeeView ? 4 : 20);
        LeftPage.Margin = new Thickness(0, 0, settings.NeeView ? 0 : 10, 0);
    }
    private async Task MoveFileAsync(int direction)
    {
        int index = Array.IndexOf(files, currentPath);
        if (index < 0) return;
        int next = ReaderFiles.NextIndex(index, files.Length, direction);
        if (next != index) await OpenAsync(files[next]);
    }
    private async Task MovePageAsync(int direction)
    {
        if (currentPath is null) return;
        int next = ReaderFiles.NextIndex(pageIndex, pageCount, direction * (settings.Spread ? 2 : 1));
        if (settings.Spread) next = next / 2 * 2;
        if (pageIndex == next) return;
        pageIndex = next;
        await RenderAsync();
    }
    private async void OnWheel(object sender, MouseWheelEventArgs e)
    {
        e.Handled = true;
        if (Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) { zoom = ReaderFiles.Zoom(zoom, e.Delta); FitPages(); return; }
        long now = Environment.TickCount64;
        if (e.Delta == 0 || now - lastWheel < 260) return;
        lastWheel = now;
        await MoveFileAsync(e.Delta > 0 ? -1 : 1);
    }
    private async void OnOpen(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Filter = "画像・マンガ|*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.zip;*.cbz", CheckFileExists = true };
        if (dialog.ShowDialog(this) == true) await OpenAsync(dialog.FileName);
    }
    private async void OnDrop(object sender, DragEventArgs e)
    { if (e.Data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } paths) await OpenAsync(paths[0]); }
    private async void OnPreviousFile(object sender, RoutedEventArgs e) => await MoveFileAsync(-1);
    private async void OnNextFile(object sender, RoutedEventArgs e) => await MoveFileAsync(1);
    private async void OnPreviousPage(object sender, RoutedEventArgs e) => await MovePageAsync(-1);
    private async void OnNextPage(object sender, RoutedEventArgs e) => await MovePageAsync(1);
    private void OnResetZoom(object sender, RoutedEventArgs e) { zoom = 1; FitPages(); }
    private void OnViewportSizeChanged(object sender, SizeChangedEventArgs e) => FitPages();
    private async void OnPageSeek(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (updatingSlider || currentPath is null) return;
        pageIndex = (int)PageSlider.Value - 1;
        if (settings.Spread) pageIndex = pageIndex / 2 * 2;
        await RenderAsync();
    }
    private async void OnSettings(object sender, RoutedEventArgs e)
    {
        settings = new(SpreadOption.IsChecked == true, BindingOption.IsChecked == true, AppearanceOption.IsChecked == true);
        ApplyAppearance();
        if (settings.Spread) pageIndex = pageIndex / 2 * 2;
        await RenderAsync();
        try { settings.Save(settingsPath); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Status.Text = $"設定を保存できませんでした: {ex.Message}"; }
    }
    private async void OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.O && Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) { e.Handled = true; OnOpen(sender, e); return; }
        if (e.OriginalSource is Slider || e.Key is not (Key.Left or Key.Right)) return;
        e.Handled = true;
        int direction = e.Key == Key.Right ? 1 : -1;
        if (Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) await MoveFileAsync(direction);
        else await MovePageAsync(settings.RightBinding ? -direction : direction);
    }
}
