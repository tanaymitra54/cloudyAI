cmake_minimum_required(VERSION 3.20)   # >=3.15 so CMP0091 (static CRT) applies
project(CloudyMouse CXX)

# Static C runtime: the exe must run on a bare Windows 10/11 with no VC++
# redistributable, exactly like whisper-cli.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

add_executable(CloudyMouse main.cpp)
target_compile_options(CloudyMouse PRIVATE /O2 /EHsc)

if (MSVC)
  target_link_options(CloudyMouse PRIVATE /SUBSYSTEM:CONSOLE)
endif()
