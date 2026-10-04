using System.Diagnostics;

namespace Ts0.Commands;

public static class InitCommand
{
    private const string ConfigTemplate = """
        {
            "entry": "src/main.ts",
            "outdir": "dist",
            "target": "node",
            "format": "esm",
            "strict": true,
            "minify": false,
            "sourcemap": true
        }
        """;

    private const string PackageJsonTemplate = """
        {
            "name": "my-ts0-app",
            "version": "1.0.0",
            "type": "module",
            "devDependencies": {
                "@types/node": "^22.0.0"
            }
        }
        """;

    private const string MainTemplate = """
        export function main() {
            console.log("Hello from ts0!");
        }

        main();
        """;

    private const string TestTemplate = """
        import { test } from "node:test";
        import { strict as assert } from "node:assert";

        test("example test", () => {
            assert.equal(1 + 1, 2);
        });
        """;

    public static void Execute(bool force)
    {
        var currentDir = Directory.GetCurrentDirectory();
        var configPath = Path.Combine(currentDir, "ts0.json");
        var srcDir = Path.Combine(currentDir, "src");
        var mainPath = Path.Combine(srcDir, "main.ts");
        var testPath = Path.Combine(srcDir, "main.test.ts");

        // Check if already initialized
        if (File.Exists(configPath) && !force)
        {
            Console.Error.WriteLine("Error: ts0.json already exists. Use --force to overwrite.");
            Environment.ExitCode = 1;
            return;
        }

        // Create src directory
        if (!Directory.Exists(srcDir))
        {
            Directory.CreateDirectory(srcDir);
            Console.WriteLine("Created src/ directory");
        }

        // Write config file
        File.WriteAllText(configPath, ConfigTemplate);
        Console.WriteLine("Created ts0.json");

        // Write package.json if not exists
        var packageJsonPath = Path.Combine(currentDir, "package.json");
        if (!File.Exists(packageJsonPath))
        {
            File.WriteAllText(packageJsonPath, PackageJsonTemplate);
            Console.WriteLine("Created package.json");
        }

        // Write main.ts if not exists or force
        if (!File.Exists(mainPath) || force)
        {
            File.WriteAllText(mainPath, MainTemplate);
            Console.WriteLine("Created src/main.ts");
        }

        // Write test file if not exists or force
        if (!File.Exists(testPath) || force)
        {
            File.WriteAllText(testPath, TestTemplate);
            Console.WriteLine("Created src/main.test.ts");
        }

        // Run npm install
        Console.WriteLine();
        Console.WriteLine("Installing dependencies...");
        var psi = new ProcessStartInfo
        {
            FileName = "npm",
            Arguments = "install",
            WorkingDirectory = currentDir,
            UseShellExecute = false
        };
        var process = Process.Start(psi);
        process?.WaitForExit();

        Console.WriteLine();
        Console.WriteLine("Project initialized! Next steps:");
        Console.WriteLine("  ts0 build    - Type-check and bundle");
        Console.WriteLine("  ts0 run      - Build and run");
        Console.WriteLine("  ts0 test     - Run tests");
    }
}
