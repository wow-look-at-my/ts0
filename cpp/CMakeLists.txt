cmake_minimum_required(VERSION 3.20)
project(ts0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Glob all source files (headers and sources live together in src/)
file(GLOB_RECURSE SOURCES CONFIGURE_DEPENDS "src/*.cpp")
file(GLOB_RECURSE HEADERS CONFIGURE_DEPENDS "src/*.hpp")

add_executable(ts0 ${SOURCES} ${HEADERS})

# Include src directory for headers
target_include_directories(ts0 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Compiler options
target_compile_options(ts0 PRIVATE -Wall -Wextra -Os)

# Static linking
target_link_options(ts0 PRIVATE -static)
