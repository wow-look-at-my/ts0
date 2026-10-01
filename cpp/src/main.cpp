#include "cli.hpp"

int main(int argc, char* argv[]) {
    auto options = ts0::Cli::parse(argc, argv);
    return ts0::Cli::run(options);
}
