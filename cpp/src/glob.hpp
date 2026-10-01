#pragma once
// Glob pattern matching for test file discovery

#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace fs = std::filesystem;

namespace glob {

// Simple wildcard matching (* and ?)
inline bool match(std::string_view pattern, std::string_view str) {
    size_t pi = 0, si = 0;
    size_t star_pi = std::string_view::npos;
    size_t star_si = 0;

    while (si < str.size()) {
        if (pi < pattern.size() && (pattern[pi] == '?' || pattern[pi] == str[si])) {
            ++pi;
            ++si;
        } else if (pi < pattern.size() && pattern[pi] == '*') {
            star_pi = pi++;
            star_si = si;
        } else if (star_pi != std::string_view::npos) {
            pi = star_pi + 1;
            si = ++star_si;
        } else {
            return false;
        }
    }

    while (pi < pattern.size() && pattern[pi] == '*') ++pi;
    return pi == pattern.size();
}

// Find files matching a glob pattern
inline std::vector<fs::path> find(const fs::path& dir, const std::string& pattern) {
    std::vector<fs::path> results;

    // Handle ** for recursive matching
    bool recursive = pattern.find("**") != std::string::npos;

    // Extract the file pattern (last component)
    std::string file_pattern = pattern;
    if (auto pos = pattern.rfind('/'); pos != std::string::npos) {
        file_pattern = pattern.substr(pos + 1);
    }

    try {
        if (recursive) {
            for (const auto& entry : fs::recursive_directory_iterator(dir,
                    fs::directory_options::skip_permission_denied)) {
                if (entry.is_regular_file()) {
                    std::string filename = entry.path().filename().string();
                    if (match(file_pattern, filename)) {
                        results.push_back(entry.path());
                    }
                }
            }
        } else {
            for (const auto& entry : fs::directory_iterator(dir)) {
                if (entry.is_regular_file()) {
                    std::string filename = entry.path().filename().string();
                    if (match(file_pattern, filename)) {
                        results.push_back(entry.path());
                    }
                }
            }
        }
    } catch (const fs::filesystem_error&) {
        // Ignore permission errors
    }

    return results;
}

} // namespace glob
