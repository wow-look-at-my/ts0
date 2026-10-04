using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ts0;

public sealed class TestConfig
{
    [JsonPropertyName("pattern")]
    public string Pattern { get; set; } = "**/*.test.ts";
}

public sealed class Ts0Config
{
    [JsonPropertyName("entry")]
    public string? Entry { get; set; }

    [JsonPropertyName("outfile")]
    public string? Outfile { get; set; }

    [JsonPropertyName("outdir")]
    public string? Outdir { get; set; }

    [JsonPropertyName("target")]
    public string Target { get; set; } = "node";

    [JsonPropertyName("format")]
    public string Format { get; set; } = "esm";

    [JsonPropertyName("strict")]
    public bool Strict { get; set; } = true;

    [JsonPropertyName("minify")]
    public bool Minify { get; set; }

    [JsonPropertyName("sourcemap")]
    public bool Sourcemap { get; set; } = true;

    [JsonPropertyName("test")]
    public TestConfig Test { get; set; } = new();

    [JsonPropertyName("esbuild")]
    public Dictionary<string, JsonElement>? Esbuild { get; set; }
}

// Source generator for AOT-compatible JSON serialization
[JsonSerializable(typeof(Ts0Config))]
[JsonSerializable(typeof(TestConfig))]
[JsonSourceGenerationOptions(
    PropertyNameCaseInsensitive = true,
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true,
    WriteIndented = true)]
public partial class Ts0JsonContext : JsonSerializerContext
{
}

public static class ConfigLoader
{
    private static readonly string[] EntryCandidates = ["src/main.ts", "src/index.ts", "main.ts", "index.ts"];

    public static string? FindConfigFile(string startDir)
    {
        var dir = new DirectoryInfo(startDir);
        while (dir != null)
        {
            var configPath = Path.Combine(dir.FullName, "ts0.json");
            if (File.Exists(configPath))
            {
                return configPath;
            }
            dir = dir.Parent;
        }
        return null;
    }

    public static (Ts0Config Config, string ProjectDir) LoadConfig(string? startDir = null)
    {
        startDir ??= Directory.GetCurrentDirectory();
        var configPath = FindConfigFile(startDir);

        Ts0Config config;
        string projectDir;

        if (configPath != null)
        {
            projectDir = Path.GetDirectoryName(configPath)!;
            var json = File.ReadAllText(configPath);
            config = JsonSerializer.Deserialize(json, Ts0JsonContext.Default.Ts0Config) ?? new Ts0Config();
        }
        else
        {
            projectDir = startDir;
            config = new Ts0Config();
        }

        // Auto-detect entry point if not specified
        if (string.IsNullOrEmpty(config.Entry))
        {
            foreach (var candidate in EntryCandidates)
            {
                var candidatePath = Path.Combine(projectDir, candidate);
                if (File.Exists(candidatePath))
                {
                    config.Entry = candidate;
                    break;
                }
            }
        }

        // Default outdir if neither outfile nor outdir specified
        if (string.IsNullOrEmpty(config.Outfile) && string.IsNullOrEmpty(config.Outdir))
        {
            config.Outdir = "dist";
        }

        return (config, projectDir);
    }
}
