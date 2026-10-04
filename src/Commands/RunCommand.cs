using System.Diagnostics;

namespace Ts0.Commands;

public static class RunCommand
{
    public static void Execute(string? file, bool noBuild, string[] passthroughArgs)
    {
        var (config, projectDir) = ConfigLoader.LoadConfig();

        string targetFile;

        if (!string.IsNullOrEmpty(file))
        {
            // Specific file provided
            targetFile = Path.IsPathRooted(file) ? file : Path.Combine(projectDir, file);
        }
        else if (!string.IsNullOrEmpty(config.Entry))
        {
            targetFile = Path.Combine(projectDir, config.Entry);
        }
        else
        {
            Console.Error.WriteLine("Error: No entry point found. Create src/main.ts or specify 'entry' in ts0.json");
            Environment.ExitCode = 1;
            return;
        }

        if (!File.Exists(targetFile))
        {
            Console.Error.WriteLine($"Error: File not found: {targetFile}");
            Environment.ExitCode = 1;
            return;
        }

        if (noBuild)
        {
            // Run directly with experimental-strip-types
            Environment.ExitCode = RunDirect(targetFile, passthroughArgs, projectDir);
            return;
        }

        // Build first
        BuildCommand.Execute(watch: false);
        if (Environment.ExitCode != 0)
        {
            return;
        }

        // Determine output path
        string outputPath;
        if (!string.IsNullOrEmpty(config.Outfile))
        {
            outputPath = Path.Combine(projectDir, config.Outfile);
        }
        else
        {
            // For outdir, derive output file name from entry
            var entryName = Path.GetFileNameWithoutExtension(config.Entry ?? "main");
            var outdirPath = Path.Combine(projectDir, config.Outdir ?? "dist");
            outputPath = Path.Combine(outdirPath, $"{entryName}.js");
        }

        if (!File.Exists(outputPath))
        {
            Console.Error.WriteLine($"Error: Built output not found: {outputPath}");
            Environment.ExitCode = 1;
            return;
        }

        Environment.ExitCode = RunFile(outputPath, passthroughArgs, projectDir);
    }

    private static int RunDirect(string filePath, string[] args, string projectDir)
    {
        var nodeArgs = $"--experimental-strip-types \"{filePath}\"";
        if (args.Length > 0)
        {
            nodeArgs += " " + string.Join(" ", args.Select(a => $"\"{a}\""));
        }

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
            Console.Error.WriteLine("Error: Failed to start Node.js");
            return 1;
        }

        process.WaitForExit();
        return process.ExitCode;
    }

    private static int RunFile(string filePath, string[] args, string projectDir)
    {
        var nodeArgs = $"\"{filePath}\"";
        if (args.Length > 0)
        {
            nodeArgs += " " + string.Join(" ", args.Select(a => $"\"{a}\""));
        }

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
            Console.Error.WriteLine("Error: Failed to start Node.js");
            return 1;
        }

        process.WaitForExit();
        return process.ExitCode;
    }
}
