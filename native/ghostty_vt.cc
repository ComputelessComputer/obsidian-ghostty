#include <napi.h>

#include "ghostty_vt.h"

#include <cstring>
#include <string>

namespace {

Napi::String Version(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), "ghostty-vt/v1.2.3");
}

Napi::String RenderDemo(const Napi::CallbackInfo &info) {
  ghostty_vt_terminal_t terminal = ghostty_vt_terminal_new(80, 24);
  if (!terminal) {
    return Napi::String::New(info.Env(),
                             "Failed to initialize Ghostty VT terminal.");
  }

  const char *demo =
      "Ghostty VT core wired ✅\n"
      "$ printf 'hello from ghostty\\n'\n"
      "hello from ghostty\n";

  ghostty_vt_terminal_feed(
      terminal, reinterpret_cast<const uint8_t *>(demo), std::strlen(demo));

  ghostty_vt_bytes_t viewport = ghostty_vt_terminal_dump_viewport(terminal);
  std::string output;
  if (viewport.ptr && viewport.len > 0) {
    output.assign(reinterpret_cast<const char *>(viewport.ptr), viewport.len);
  } else {
    output = "(no viewport output)";
  }
  ghostty_vt_bytes_free(viewport);
  ghostty_vt_terminal_free(terminal);

  return Napi::String::New(info.Env(), output);
}

class GhosttyTerminal : public Napi::ObjectWrap<GhosttyTerminal> {
public:
  static void Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(
        env,
        "GhosttyTerminal",
        {
            InstanceMethod("feed", &GhosttyTerminal::Feed),
            InstanceMethod("resize", &GhosttyTerminal::Resize),
            InstanceMethod("scrollViewport", &GhosttyTerminal::ScrollViewport),
            InstanceMethod("dumpViewport", &GhosttyTerminal::DumpViewport),
            InstanceMethod("cursorPosition", &GhosttyTerminal::CursorPosition),
            InstanceMethod("free", &GhosttyTerminal::Free),
        });

    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    exports.Set("Terminal", func);
    exports.Set("createTerminal",
                Napi::Function::New(env, GhosttyTerminal::Create));
  }

  GhosttyTerminal(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<GhosttyTerminal>(info), terminal_(nullptr) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
      Napi::TypeError::New(env, "Expected cols, rows").ThrowAsJavaScriptException();
      return;
    }

    uint16_t cols = static_cast<uint16_t>(info[0].As<Napi::Number>().Uint32Value());
    uint16_t rows = static_cast<uint16_t>(info[1].As<Napi::Number>().Uint32Value());
    terminal_ = ghostty_vt_terminal_new(cols, rows);
    if (!terminal_) {
      Napi::Error::New(env, "Failed to create Ghostty VT terminal")
          .ThrowAsJavaScriptException();
    }
  }

  ~GhosttyTerminal() override { FreeInternal(); }

private:
  static Napi::FunctionReference constructor;
  ghostty_vt_terminal_t terminal_;

  static Napi::Value Create(const Napi::CallbackInfo &info) {
    return constructor.New({info[0], info[1]});
  }

  void FreeInternal() {
    if (terminal_) {
      ghostty_vt_terminal_free(terminal_);
      terminal_ = nullptr;
    }
  }

  Napi::Value Feed(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!terminal_) {
      return Napi::Number::New(env, 1);
    }
    if (info.Length() < 1) {
      return Napi::Number::New(env, 2);
    }

    if (info[0].IsBuffer()) {
      auto buf = info[0].As<Napi::Buffer<uint8_t>>();
      int result =
          ghostty_vt_terminal_feed(terminal_, buf.Data(), buf.Length());
      return Napi::Number::New(env, result);
    }

    if (info[0].IsString()) {
      std::string data = info[0].As<Napi::String>().Utf8Value();
      int result = ghostty_vt_terminal_feed(
          terminal_,
          reinterpret_cast<const uint8_t *>(data.data()),
          data.size());
      return Napi::Number::New(env, result);
    }

    return Napi::Number::New(env, 3);
  }

  Napi::Value Resize(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!terminal_) {
      return Napi::Number::New(env, 1);
    }
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
      return Napi::Number::New(env, 2);
    }
    uint16_t cols = static_cast<uint16_t>(info[0].As<Napi::Number>().Uint32Value());
    uint16_t rows = static_cast<uint16_t>(info[1].As<Napi::Number>().Uint32Value());
    int result = ghostty_vt_terminal_resize(terminal_, cols, rows);
    return Napi::Number::New(env, result);
  }

  Napi::Value ScrollViewport(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!terminal_) {
      return Napi::Number::New(env, 1);
    }
    if (info.Length() < 1 || !info[0].IsNumber()) {
      return Napi::Number::New(env, 2);
    }
    int32_t delta = info[0].As<Napi::Number>().Int32Value();
    int result = ghostty_vt_terminal_scroll_viewport(terminal_, delta);
    return Napi::Number::New(env, result);
  }

  Napi::Value DumpViewport(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!terminal_) {
      return Napi::String::New(env, "");
    }

    ghostty_vt_bytes_t viewport = ghostty_vt_terminal_dump_viewport(terminal_);
    std::string output;
    if (viewport.ptr && viewport.len > 0) {
      output.assign(reinterpret_cast<const char *>(viewport.ptr), viewport.len);
    }
    ghostty_vt_bytes_free(viewport);
    return Napi::String::New(env, output);
  }
  Napi::Value CursorPosition(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    if (!terminal_) {
      result.Set("valid", Napi::Boolean::New(env, false));
      result.Set("col", Napi::Number::New(env, 0));
      result.Set("row", Napi::Number::New(env, 0));
      return result;
    }

    uint16_t col = 0;
    uint16_t row = 0;
    bool ok = ghostty_vt_terminal_cursor_position(terminal_, &col, &row);
    result.Set("valid", Napi::Boolean::New(env, ok));
    result.Set("col", Napi::Number::New(env, col));
    result.Set("row", Napi::Number::New(env, row));
    return result;
  }

  Napi::Value Free(const Napi::CallbackInfo &info) {
    FreeInternal();
    return info.Env().Undefined();
  }
};

Napi::FunctionReference GhosttyTerminal::constructor;

} // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("renderDemo", Napi::Function::New(env, RenderDemo));
  GhosttyTerminal::Init(env, exports);
  return exports;
}

NODE_API_MODULE(ghostty_vt, Init)
