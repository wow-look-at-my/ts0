using Ts0.Commands;

namespace Ts0;

public static class Cli
{
    public static int Run(string[] args)
    {
        if (args.Length == 0 || args[0] == "-h" || args[0] == "--help")
        {
            ShowHelp();
            return 0;
        }

        var command = args[0];
        var options = ParseOptions(args[1..]);

        return command switch
        {
            "init" => RunInit(options),
            "build" => RunBuild(options),
            "run" => RunRun(args[1..], options),
            "test" => RunTest(options),
            _ => ShowUnknownCommand(command)
        };
    }

    private static void ShowHelp()
    {
        Console.WriteLine("ts0 - A simple TypeScript framework with good defaults");
        Console.WriteLine();
        Console.WriteLine("Usage: ts0 <command> [options]");
        Console.WriteLine();
        Console.WriteLine("Commands:");
        Console.WriteLine("  init          Initialize a new ts0 project");
        Console.WriteLine("  build         Type-check and bundle the project");
        Console.WriteLine("  run [file]    Build and run the entry point (or a specific file)");
        Console.WriteLine("  test          Run tests using Node's built-in test runner");
        Console.WriteLine();
        Console.WriteLine("Options:");
        Console.WriteLine("  -h, --help    Show help");
        Console.WriteLine("  -w, --watch   Watch mode (build, test)");
        Console.WriteLine("  --force       Force overwrite (init)");
        Console.WriteLine("  --no-build    Skip build step (run)");
    }

    private static int ShowUnknownCommand(string command)
    {
        Console.Error.WriteLine($"Unknown command: {command}");
        Console.Error.WriteLine("Run 'ts0 --help' for usage.");
        return 1;
    }

    private static Dictionary<string, bool> ParseOptions(string[] args)
    {
        var options = new Dictionary<string, bool>();
        foreach (var arg in args)
        {
            if (arg.StartsWith('-'))
            {
                options[arg] = true;
            }
        }
        return options;
    }

    private static int RunInit(Dictionary<string, bool> options)
    {
        var force = options.ContainsKey("--force");
        InitCommand.Execute(force);
        return Environment.ExitCode;
    }

    private static int RunBuild(Dictionary<string, bool> options)
    {
        var watch = options.ContainsKey("-w") || options.ContainsKey("--watch");
        BuildCommand.Execute(watch);
        return Environment.ExitCode;
    }

    private static int RunRun(string[] args, Dictionary<string, bool> options)
    {
        var noBuild = options.ContainsKey("--no-build");
        string? file = null;

        foreach (var arg in args)
        {
            if (!arg.StartsWith('-'))
            {
                file = arg;
                break;
            }
        }

        RunCommand.Execute(file, noBuild, []);
        return Environment.ExitCode;
    }

    private static int RunTest(Dictionary<string, bool> options)
    {
        var watch = options.ContainsKey("-w") || options.ContainsKey("--watch");
        TestCommand.Execute(watch);
        return Environment.ExitCode;
    }
}
