# Cosmopolitan Libc CMake Toolchain File
cmake_minimum_required(VERSION 3.20)

set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

# Find cosmocc relative to toolchain file
get_filename_component(TOOLCHAIN_DIR "${CMAKE_CURRENT_LIST_DIR}" ABSOLUTE)
set(COSMO_BIN "${TOOLCHAIN_DIR}/cosmocc/bin")

# Set compilers
set(CMAKE_C_COMPILER "${COSMO_BIN}/cosmocc")
set(CMAKE_CXX_COMPILER "${COSMO_BIN}/cosmoc++")
set(CMAKE_AR "${COSMO_BIN}/cosmoar")
set(CMAKE_RANLIB "${COSMO_BIN}/cosmoranlib")

# Critical: Set object file extension to .o (cosmocc requirement)
set(CMAKE_C_OUTPUT_EXTENSION .o)
set(CMAKE_CXX_OUTPUT_EXTENSION .o)
set(CMAKE_ASM_OUTPUT_EXTENSION .o)

# Static linking only
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_FIND_LIBRARY_SUFFIXES ".a")

# Compiler flags
set(CMAKE_C_FLAGS_INIT "-static")
set(CMAKE_CXX_FLAGS_INIT "-static -std=c++20")
set(CMAKE_EXE_LINKER_FLAGS_INIT "-static")

# Don't try to test compilers with executables (cross-compile)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# Disable shared library building
set(CMAKE_SHARED_LIBRARY_LINK_C_FLAGS "")
set(CMAKE_SHARED_LIBRARY_LINK_CXX_FLAGS "")
