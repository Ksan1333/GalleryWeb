using System.Windows;

namespace PixVault.Native;
public partial class App : Application
{
    private void OnStartup(object sender, StartupEventArgs e)
    {
        var window = new MainWindow();
        MainWindow = window;
        window.Show();
        if (e.Args.Length > 0) _ = window.OpenAsync(e.Args[0]);
    }
}
