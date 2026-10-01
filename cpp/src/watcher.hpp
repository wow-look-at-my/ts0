#pragma once

#include <string>
#include <vector>
#include <functional>
#include <filesystem>
#include <atomic>
#include <thread>
#include <map>

namespace ts0 {

enum class WatchEventType {
    Created,
    Modified,
    Deleted
};

struct WatchEvent {
    WatchEventType type;
    std::filesystem::path path;
};

using WatchCallback = std::function<void(const WatchEvent&)>;

class FileWatcher {
public:
    FileWatcher();
    ~FileWatcher();

    void watch(const std::filesystem::path& path, const WatchCallback& callback);
    void watch_glob(const std::string& pattern, const std::filesystem::path& base_dir, const WatchCallback& callback);

    void start();
    void stop();

    bool is_running() const { return running_.load(); }

private:
    void run_loop();

#ifdef __linux__
    int inotify_fd_;
    std::map<int, std::filesystem::path> watch_descriptors_;
#endif
    std::map<std::filesystem::path, WatchCallback> callbacks_;
    std::string glob_pattern_;
    std::filesystem::path glob_base_;
    WatchCallback glob_callback_;

    std::atomic<bool> running_;
    std::thread watch_thread_;
};

} // namespace ts0
