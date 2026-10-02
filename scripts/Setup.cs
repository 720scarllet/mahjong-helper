using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

class SetupForm : Form {
    readonly string root;
    readonly TextBox log = new TextBox();
    readonly Button configure = new Button();
    readonly Button launch = new Button();
    readonly ProgressBar progress = new ProgressBar();
    bool busy;
    public SetupForm(string directory) {
        root = Path.GetFullPath(directory);
        Text = "雀魂助手配置"; ClientSize = new Size(680, 390);
        StartPosition = FormStartPosition.CenterScreen; MinimumSize = Size;
        Font = new Font("Microsoft YaHei UI", 9);
        log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical;
        log.SetBounds(16, 16, 648, 290); log.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        progress.SetBounds(16, 319, 648, 12); progress.Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        configure.Text = "配置并构建"; configure.SetBounds(16, 346, 140, 30); configure.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
        launch.Text = "启动助手"; launch.SetBounds(524, 346, 140, 30); launch.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        launch.Enabled = File.Exists(ApplicationPath());
        Controls.AddRange(new Control[]{log,progress,configure,launch});
        configure.Click += delegate { Configure(); };
        Shown += delegate { Configure(); };
        launch.Click += delegate { Process.Start(new ProcessStartInfo(ApplicationPath()){WorkingDirectory=Path.GetDirectoryName(ApplicationPath()),UseShellExecute=true}); Close(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if(busy)e.Cancel = true; };
        log.Text = "配置文件保存在项目目录中。首次配置需要联网。\r\n";
    }
    string ApplicationPath() { return Path.Combine(root, "release", "win-unpacked", "Mahjong Helper Overlay.exe"); }
    void Configure() {
        busy = true; configure.Enabled = false; launch.Enabled = false; progress.Style = ProgressBarStyle.Marquee;
        var worker = new BackgroundWorker(); worker.WorkerReportsProgress = true;
        worker.ProgressChanged += delegate(object sender, ProgressChangedEventArgs e) { log.AppendText((string)e.UserState + "\r\n"); };
        worker.DoWork += delegate {
            string script = Path.Combine(root,"scripts","setup.ps1");
            var info = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \""+script+"\"") {
                WorkingDirectory=root, UseShellExecute=false, CreateNoWindow=true,
                RedirectStandardOutput=true, RedirectStandardError=true,
                StandardOutputEncoding=Encoding.UTF8, StandardErrorEncoding=Encoding.UTF8
            };
            using(var process = new Process()) {
                process.StartInfo=info;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if(e.Data!=null)worker.ReportProgress(0,e.Data); };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if(e.Data!=null)worker.ReportProgress(0,e.Data); };
                process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine(); process.WaitForExit();
                if(process.ExitCode!=0)throw new Exception("配置失败，可重新点击配置重试。请检查上方错误。");
            }
        };
        worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs e) {
            busy=false; configure.Enabled=true; progress.Style=ProgressBarStyle.Blocks;
            if(e.Error!=null)log.AppendText(e.Error.Message+"\r\n");
            else { progress.Value=100; log.AppendText("配置完成。\r\n"); }
            launch.Enabled=e.Error==null && File.Exists(ApplicationPath());
        };
        worker.RunWorkerAsync();
    }
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string root=args.Length>0?args[0]:Path.GetDirectoryName(Application.ExecutablePath);
        Application.Run(new SetupForm(root));
    }
}
