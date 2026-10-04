using System.Diagnostics;

namespace Ts0.Commands;

public static class TestCommand
{
    public static void Execute(bool watch)
    {
        var (config, projectDir) = ConfigLoader.LoadConfig();
        var pattern = config.Test?.Pattern ?? "**/*.test.ts";

        // Find test files using glob pattern
        var testFiles = FindTestFiles(projectDir, pattern);

        if (testFiles.Count == 0)
        {
            Console.WriteLine($"No test files found matching pattern: {pattern}");
            return;
        }

        Console.WriteLine($"Found {testFiles.Count} test file(s)");

        int result;
        if (watch)
        {
            result = ExecuteWatch(testFiles, projectDir, pattern);
        }
        else
        {
            result = RunTests(testFiles, projectDir);
        }

        if (result != 0)
        {
            Environment.ExitCode = result;
        }
    }

    private static List<string> FindTestFiles(string projectDir, string pattern)
    {
        var files = new List<string>();

        // Simple glob matching for common patterns
        // Supports ** for recursive, * for single level
        var searchPattern = pattern.Replace("**", "*");
        if (searchPattern.StartsWith("*"))
        {
            searchPattern = "*" + searchPattern.TrimStart('*');
        }

        try
        {
            var allFiles = Directory.GetFiles(projectDir, "*.test.ts", SearchOption.AllDirectories);
            foreach (var file in allFiles)
            {
                // Exclude node_modules and dist
                var relativePath = Path.GetRelativePath(projectDir, file);
                if (!relativePath.StartsWith("node_modules") && !relativePath.StartsWith("dist"))
                {
                    files.Add(file);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Warning: Error searching for test files: {ex.Message}");
        }

        return files;
    }

    private static int RunTests(List<string> testFiles, string projectDir)
    {
        // Build arguments for node test runner
        var fileArgs = string.Join(" ", testFiles.Select(f => $"\"{f}\""));
        var nodeArgs = $"--experimental-strip-types --test {fileArgs}";

        var psi = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = nodeArgs,
            WorkingDirectory = projectDir,
            UseShellExecute = false
        };

        using var process = Process.Start(psi);
        if (process == null)
        {
            Console.Error.WriteLine("Error: Failed to start Node.js test runner");
            return 1;
        }

        process.WaitForExit();
        return process.ExitCode;
    }

    private static int ExecuteWatch(List<string> testFiles, string projectDir, string pattern)
    {
        Console.WriteLine("Starting test watch mode...");

        // Initial test run
        var result = RunTests(testFiles, projectDir);
        if (result != 0)
        {
            Console.WriteLine("Tests failed, watching for changes...");
        }

        // Set up file watcher
        using var watcher = new FileSystemWatcher(projectDir);
        watcher.Filter = "*.ts";
        watcher.IncludeSubdirectories = true;
        watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName;

        var debounceTimer = new System.Timers.Timer(100);
        debounceTimer.AutoReset = false;
        debounceTimer.Elapsed += (s, e) =>
        {
            Console.WriteLine("\nRe-running tests...");
            var updatedFiles = FindTestFiles(projectDir, pattern);
            RunTests(updatedFiles, projectDir);
        };

        watcher.Changed += (s, e) =>
        {
            if (!e.FullPath.Contains("node_modules") && !e.FullPath.Contains("dist"))
            {
                debounceTimer.Stop();
                debounceTimer.Start();
            }
        };
        watcher.Created += (s, e) =>
        {
            if (!e.FullPath.Contains("node_modules") && !e.FullPath.Contains("dist"))
            {
                debounceTimer.Stop();
                debounceTimer.Start();
            }
        };
        watcher.Deleted += (s, e) =>
        {
            if (!e.FullPath.Contains("node_modules") && !e.FullPath.Contains("dist"))
            {
                debounceTimer.Stop();
                debounceTimer.Start();
            }
        };

        watcher.EnableRaisingEvents = true;

        Console.WriteLine("Watching for changes... (Press Ctrl+C to stop)");

        // Wait indefinitely
        var exitEvent = new ManualResetEvent(false);
        Console.CancelKeyPress += (s, e) =>
        {
            e.Cancel = true;
            exitEvent.Set();
        };
        exitEvent.WaitOne();

        return 0;
    }
}
