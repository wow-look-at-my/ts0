using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ts0.Commands;

// TypeScript config model for AOT-compatible serialization
public sealed class TsCompilerOptions
{
    [JsonPropertyName("target")]
    public string Target { get; set; } = "ESNext";

    [JsonPropertyName("module")]
    public string Module { get; set; } = "NodeNext";

    [JsonPropertyName("moduleResolution")]
    public string ModuleResolution { get; set; } = "NodeNext";

    [JsonPropertyName("strict")]
    public bool Strict { get; set; } = true;

    [JsonPropertyName("skipLibCheck")]
    public bool SkipLibCheck { get; set; } = true;

    [JsonPropertyName("noEmit")]
    public bool NoEmit { get; set; } = true;

    [JsonPropertyName("esModuleInterop")]
    public bool EsModuleInterop { get; set; } = true;

    [JsonPropertyName("resolveJsonModule")]
    public bool ResolveJsonModule { get; set; } = true;

    [JsonPropertyName("declaration")]
    public bool Declaration { get; set; }

    [JsonPropertyName("types")]
    public string[] Types { get; set; } = ["node"];
}

public sealed class TsConfigJson
{
    [JsonPropertyName("compilerOptions")]
    public TsCompilerOptions CompilerOptions { get; set; } = new();

    [JsonPropertyName("include")]
    public string[] Include { get; set; } = ["**/*.ts"];

    [JsonPropertyName("exclude")]
    public string[] Exclude { get; set; } = ["node_modules", "dist"];
}

[JsonSerializable(typeof(TsConfigJson))]
[JsonSourceGenerationOptions(WriteIndented = true)]
public partial class TsConfigJsonContext : JsonSerializerContext
{
}

public static class BuildCommand
{
    public static void Execute(bool watch)
    {
        var (config, projectDir) = ConfigLoader.LoadConfig();

        if (string.IsNullOrEmpty(config.Entry))
        {
            Console.Error.WriteLine("Error: No entry point found. Create src/main.ts or specify 'entry' in ts0.json");
            Environment.ExitCode = 1;
            return;
        }

        var entryPath = Path.Combine(projectDir, config.Entry);
        if (!File.Exists(entryPath))
        {
            Console.Error.WriteLine($"Error: Entry point not found: {config.Entry}");
            Environment.ExitCode = 1;
            return;
        }

        int result;
        if (watch)
        {
            result = ExecuteWatch(config, projectDir);
        }
        else
        {
            result = ExecuteBuild(config, projectDir);
        }

        if (result != 0)
        {
            Environment.ExitCode = result;
        }
    }

    private static int ExecuteBuild(Ts0Config config, string projectDir)
    {
        var sw = Stopwatch.StartNew();

        // Step 1: Type-check with TypeScript
        Console.WriteLine("Type-checking...");
        var typeCheckResult = RunTypeCheck(config, projectDir);
        if (typeCheckResult != 0)
        {
            return typeCheckResult;
        }

        // Step 2: Bundle with esbuild
        Console.WriteLine("Bundling...");
        var bundleResult = RunBundle(config, projectDir);
        if (bundleResult != 0)
        {
            return bundleResult;
        }

        sw.Stop();
        Console.WriteLine($"Build completed in {sw.ElapsedMilliseconds}ms");
        return 0;
    }

    private static int ExecuteWatch(Ts0Config config, string projectDir)
    {
        Console.WriteLine("Starting watch mode...");

        // Initial build
        var result = ExecuteBuild(config, projectDir);
        if (result != 0)
        {
            Console.WriteLine("Initial build failed, watching for changes...");
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
            Console.WriteLine("\nRebuilding...");
            ExecuteBuild(config, projectDir);
        };

        watcher.Changed += (s, e) =>
        {
            debounceTimer.Stop();
            debounceTimer.Start();
        };
        watcher.Created += (s, e) =>
        {
            debounceTimer.Stop();
            debounceTimer.Start();
        };
        watcher.Deleted += (s, e) =>
        {
            debounceTimer.Stop();
            debounceTimer.Start();
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

    private static int RunTypeCheck(Ts0Config config, string projectDir)
    {
        // Generate temporary tsconfig
        var tsconfigPath = Path.Combine(projectDir, ".ts0-tsconfig.json");
        var tsconfig = new TsConfigJson
        {
            CompilerOptions = new TsCompilerOptions
            {
                Strict = config.Strict
            }
        };

        var tsconfigJson = JsonSerializer.Serialize(tsconfig, TsConfigJsonContext.Default.TsConfigJson);
        File.WriteAllText(tsconfigPath, tsconfigJson);

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "npx",
                Arguments = $"tsc --project \"{tsconfigPath}\"",
                WorkingDirectory = projectDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };

            using var process = Process.Start(psi);
            if (process == null)
            {
                Console.Error.WriteLine("Error: Failed to start TypeScript compiler");
                return 1;
            }

            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            if (!string.IsNullOrWhiteSpace(stdout))
            {
                Console.Write(stdout);
            }
            if (!string.IsNullOrWhiteSpace(stderr))
            {
                Console.Error.Write(stderr);
            }

            return process.ExitCode;
        }
        finally
        {
            // Clean up temp tsconfig
            if (File.Exists(tsconfigPath))
            {
                File.Delete(tsconfigPath);
            }
        }
    }

    private static int RunBundle(Ts0Config config, string projectDir)
    {
        var args = new StringBuilder();
        var entryPath = Path.Combine(projectDir, config.Entry!);

        args.Append($"\"{entryPath}\"");
        args.Append(" --bundle");
        args.Append($" --platform={config.Target}");
        args.Append($" --format={config.Format}");
        args.Append(" --target=esnext");

        if (config.Minify)
        {
            args.Append(" --minify");
        }

        if (config.Sourcemap)
        {
            args.Append(" --sourcemap");
        }

        if (!string.IsNullOrEmpty(config.Outfile))
        {
            var outfilePath = Path.Combine(projectDir, config.Outfile);
            args.Append($" --outfile=\"{outfilePath}\"");
            args.Append(" --banner:js=\"#!/usr/bin/env node\"");
        }
        else
        {
            var outdirPath = Path.Combine(projectDir, config.Outdir ?? "dist");
            args.Append($" --outdir=\"{outdirPath}\"");
        }

        // External packages for node target
        if (config.Target == "node")
        {
            args.Append(" --packages=external");
        }

        var psi = new ProcessStartInfo
        {
            FileName = "npx",
            Arguments = $"esbuild {args}",
            WorkingDirectory = projectDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };

        using var process = Process.Start(psi);
        if (process == null)
        {
            Console.Error.WriteLine("Error: Failed to start esbuild");
            return 1;
        }

        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        if (!string.IsNullOrWhiteSpace(stdout))
        {
            Console.Write(stdout);
        }
        if (!string.IsNullOrWhiteSpace(stderr))
        {
            Console.Error.Write(stderr);
        }

        // Make output file executable if it has a shebang
        if (!string.IsNullOrEmpty(config.Outfile) && process.ExitCode == 0)
        {
            var outfilePath = Path.Combine(projectDir, config.Outfile);
            if (File.Exists(outfilePath) && !OperatingSystem.IsWindows())
            {
                var chmodPsi = new ProcessStartInfo
                {
                    FileName = "chmod",
                    Arguments = $"+x \"{outfilePath}\"",
                    UseShellExecute = false
                };
                Process.Start(chmodPsi)?.WaitForExit();
            }
        }

        return process.ExitCode;
    }
}
