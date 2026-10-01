cmake_minimum_required(VERSION 3.20)
project(ts0 VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Source files
set(SOURCES
    src/main.cpp
    src/cli.cpp
    src/config.cpp
    src/json.cpp
    src/glob.cpp
    src/process.cpp
    src/watcher.cpp
    src/commands/init.cpp
    src/commands/build.cpp
    src/commands/run.cpp
    src/commands/test.cpp
)

# Create executable
add_executable(ts0 ${SOURCES})

# Include directories
target_include_directories(ts0 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Platform-specific configuration
if(WIN32)
    # Windows: Use static runtime
    set_property(TARGET ts0 PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    target_compile_definitions(ts0 PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
    # Optimization for release
    target_compile_options(ts0 PRIVATE $<$<CONFIG:Release>:/O2 /GL>)
    target_link_options(ts0 PRIVATE $<$<CONFIG:Release>:/LTCG>)
elseif(APPLE)
    # macOS: Can't fully static link, but optimize
    target_compile_options(ts0 PRIVATE $<$<CONFIG:Release>:-O3 -flto>)
    target_link_options(ts0 PRIVATE $<$<CONFIG:Release>:-flto>)
else()
    # Linux: Full static linking
    target_compile_options(ts0 PRIVATE $<$<CONFIG:Release>:-O3 -flto>)
    target_link_options(ts0 PRIVATE -static -static-libgcc -static-libstdc++ $<$<CONFIG:Release>:-flto -s>)
    find_package(Threads REQUIRED)
    target_link_libraries(ts0 PRIVATE Threads::Threads)
endif()

# Installation
install(TARGETS ts0 RUNTIME DESTINATION bin)
