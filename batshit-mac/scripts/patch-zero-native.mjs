#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appkitHostPath = process.env.BATSHIT_ZERO_NATIVE_APPKIT_HOST_PATH || path.resolve(
  __dirname,
  '..',
  'node_modules',
  'zero-native',
  'src',
  'platform',
  'macos',
  'appkit_host.m'
)
const appkitHostHeaderPath = process.env.BATSHIT_ZERO_NATIVE_APPKIT_HEADER_PATH || path.resolve(
  __dirname,
  '..',
  'node_modules',
  'zero-native',
  'src',
  'platform',
  'macos',
  'appkit_host.h'
)
const cefHostPath = process.env.BATSHIT_ZERO_NATIVE_CEF_HOST_PATH || path.resolve(
  __dirname,
  '..',
  'node_modules',
  'zero-native',
  'src',
  'platform',
  'macos',
  'cef_host.mm'
)

const marker = 'runOpenPanelWithParameters'
const mediaCaptureMarker = 'requestMediaCapturePermissionFor'
const mediaPlaybackPolicyMarker = 'BATSHIT_MEDIA_PLAYBACK_POLICY'
const quitLifecycleMarker = 'BATSHIT_QUIT_LIFECYCLE_ASYNC_V3'
const previousQuitLifecycleMarkers = [
  '// BATSHIT_QUIT_LIFECYCLE_ASYNC_V2:',
  '// BATSHIT_QUIT_LIFECYCLE_ASYNC:'
]
const legacyQuitLifecycleMarker = '// BATSHIT_QUIT_LIFECYCLE:'
const cefMathMarker = 'BATSHIT_CEF_MATH_MACRO_COMPAT'
const webviewHeaderMarker = 'zero_native_appkit_create_webview'

function assertNeedleOrReplacement(source, needle, replacement, label) {
  if (source.includes(needle) || source.includes(replacement)) return
  throw new Error(`Unable to find ${label} in Zero Native AppKit host.`)
}

function assertAnyNeedleOrReplacement(source, pairs, label) {
  if (pairs.some(({ needle, replacement }) => source.includes(needle) || source.includes(replacement))) {
    return
  }
  throw new Error(`Unable to find ${label} in Zero Native AppKit host.`)
}

if (!fs.existsSync(appkitHostPath)) {
  throw new Error(`Zero Native AppKit host source is missing: ${appkitHostPath}`)
}
if (!fs.existsSync(appkitHostHeaderPath)) {
  throw new Error(`Zero Native AppKit host header is missing: ${appkitHostHeaderPath}`)
}

let source = fs.readFileSync(appkitHostPath, 'utf8')
const original = source

const appkitInterfaceNeedle = '@interface ZeroNativeAppKitHost : NSObject <WKNavigationDelegate>'
const appkitInterfaceReplacement = '@interface ZeroNativeAppKitHost : NSObject <WKNavigationDelegate, WKUIDelegate>'
const appkitInterfaceWithQuitLifecycle = '@interface ZeroNativeAppKitHost : NSObject <WKNavigationDelegate, WKUIDelegate, NSApplicationDelegate>'
assertAnyNeedleOrReplacement(
  source,
  [
    { needle: appkitInterfaceNeedle, replacement: appkitInterfaceReplacement },
    { needle: appkitInterfaceWithQuitLifecycle, replacement: appkitInterfaceWithQuitLifecycle }
  ],
  'ZeroNativeAppKitHost interface declaration for WKUIDelegate patch'
)
source = source.replace(
  appkitInterfaceNeedle,
  appkitInterfaceReplacement
)

assertAnyNeedleOrReplacement(
  source,
  [
    {
      needle: 'webView.navigationDelegate = self;\n    webView.autoresizingMask',
      replacement: 'webView.navigationDelegate = self;\n    webView.UIDelegate = self;\n    webView.autoresizingMask'
    },
    {
      needle: 'webview.navigationDelegate = self;\n    webview.autoresizingMask',
      replacement: 'webview.navigationDelegate = self;\n    webview.UIDelegate = self;\n    webview.autoresizingMask'
    }
  ],
  'WKWebView delegate assignment for WKUIDelegate patch'
)
source = source.replaceAll(
  'webView.navigationDelegate = self;\n    webView.autoresizingMask',
  'webView.navigationDelegate = self;\n    webView.UIDelegate = self;\n    webView.autoresizingMask'
)
source = source.replaceAll(
  'webview.navigationDelegate = self;\n    webview.autoresizingMask',
  'webview.navigationDelegate = self;\n    webview.UIDelegate = self;\n    webview.autoresizingMask'
)

if (!source.includes(marker)) {
  const insertionPoint =
    '- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {'
  const openPanelDelegate = `- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> * _Nullable URLs))completionHandler {
    (void)frame;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = YES;
    if (@available(macOS 10.13.4, *)) {
        panel.canChooseDirectories = parameters.allowsDirectories;
    } else {
        panel.canChooseDirectories = NO;
    }
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;

    NSWindow *window = webView.window ?: NSApp.keyWindow;
    void (^finish)(NSModalResponse) = ^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URLs : @[]);
    };
    if (window) {
        [panel beginSheetModalForWindow:window completionHandler:finish];
    } else {
        finish([panel runModal]);
    }
}

`
  if (!source.includes(insertionPoint)) {
    throw new Error('Unable to find WKNavigationDelegate insertion point in Zero Native AppKit host.')
  }
  source = source.replace(insertionPoint, `${openPanelDelegate}${insertionPoint}`)
}

if (!source.includes(mediaCaptureMarker)) {
  const insertionPoint =
    '- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {'
  const mediaCaptureDelegate = `#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 120000
- (void)webView:(WKWebView *)webView requestMediaCapturePermissionFor:(WKSecurityOrigin *)origin initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision decision))decisionHandler API_AVAILABLE(macos(12.0)) {
    (void)webView;
    (void)frame;
    NSString *protocol = origin.protocol ?: @"";
    NSString *host = origin.host ?: @"";
    BOOL localHttpOrigin =
        [protocol isEqualToString:@"http"] &&
        ([host isEqualToString:@"localhost"] ||
         [host isEqualToString:@"127.0.0.1"] ||
         [host isEqualToString:@"::1"]);
    BOOL packagedOrigin = [protocol isEqualToString:@"zero"];
    BOOL microphoneRequest =
        type == WKMediaCaptureTypeMicrophone ||
        type == WKMediaCaptureTypeCameraAndMicrophone;
    decisionHandler((microphoneRequest && (localHttpOrigin || packagedOrigin)) ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
}
#endif

`
  if (!source.includes(insertionPoint)) {
    throw new Error('Unable to find WKNavigationDelegate insertion point for media capture patch in Zero Native AppKit host.')
  }
  source = source.replace(insertionPoint, `${mediaCaptureDelegate}${insertionPoint}`)
}

if (!source.includes(mediaPlaybackPolicyMarker)) {
  const configurationNeedle = 'WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];'
  const configurationReplacement = `${configurationNeedle}
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 101200
    // ${mediaPlaybackPolicyMarker}: Batshit voice previews and chat speech can start
    // after slow local TTS work completes, outside the original click gesture.
    configuration.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
#endif`
  if (!source.includes(configurationNeedle)) {
    throw new Error('Unable to find WKWebViewConfiguration initialization for media playback policy patch.')
  }
  source = source.replaceAll(configurationNeedle, configurationReplacement)
}

if (!source.includes(quitLifecycleMarker)) {
  // Quit lifecycle: upstream Zero Native exits the run loop when the last window
  // closes, but Cmd+Q / Dock Quit / logout go through NSApp terminate:, which
  // kills the process without ever returning to the Zig shell. Batshit must stop
  // its runtime supervisor on every quit path, so this patch:
  //   1. makes the host the NSApplicationDelegate and intercepts terminate:,
  //      running the app-side shutdown hook before replying to AppKit,
  //   2. keeps AppKit responsive with NSTerminateLater while the Zig-side worker
  //      waits for the runtime supervisor,
  //   3. closes WKWebViews immediately so their SSE requests cannot hold adapter-node
  //      open, and finishes termination only after the supervisor marker appears.
  const interfaceNeedle =
    '@interface ZeroNativeAppKitHost : NSObject <WKNavigationDelegate, WKUIDelegate>'
  const interfaceWithDelegate =
    '@interface ZeroNativeAppKitHost : NSObject <WKNavigationDelegate, WKUIDelegate, NSApplicationDelegate>'
  if (!source.includes(interfaceNeedle) && !source.includes(interfaceWithDelegate)) {
    throw new Error('Unable to find ZeroNativeAppKitHost interface declaration for quit lifecycle patch.')
  }
  source = source.replace(interfaceNeedle, interfaceWithDelegate)

  const propertyNeedle = '@property(nonatomic, assign) BOOL didShutdown;'
  if (!source.includes(propertyNeedle)) {
    throw new Error('Unable to find didShutdown property for quit lifecycle patch.')
  }
  const lifecycleProperties = [
    '@property(nonatomic, strong) NSWindow *shutdownNoticeWindow;',
    '@property(nonatomic, strong) NSTextField *shutdownDetailLabel;',
    '@property(nonatomic, strong) NSTimer *shutdownCompletionTimer;',
    '@property(nonatomic, strong) NSDate *shutdownStartedAt;',
    '@property(nonatomic, assign) BOOL shutdownInProgress;',
    '@property(nonatomic, assign) BOOL shutdownFinished;'
  ]
  for (const property of lifecycleProperties) {
    if (!source.includes(property)) {
      source = source.replace(propertyNeedle, `${propertyNeedle}\n${property}`)
    }
  }

  const declarationNeedle = '- (void)emitShutdown;'
  if (!source.includes(declarationNeedle)) {
    throw new Error('Unable to find emitShutdown declaration for quit lifecycle patch.')
  }
  const lifecycleDeclarations = [
    '- (void)showShutdownNotice;',
    '- (void)disconnectWebViewsForShutdown;',
    '- (void)beginAsynchronousShutdown;',
    '- (void)pollShutdownCompletion:(NSTimer *)timer;',
    '- (void)failAsynchronousShutdown:(NSString *)message;',
    '- (NSString *)shutdownCompletionMarkerPath;'
  ]
  for (const declaration of lifecycleDeclarations) {
    if (!source.includes(declaration)) {
      source = source.replace(declarationNeedle, `${declarationNeedle}\n${declaration}`)
    }
  }

  const configureNeedle =
    '- (void)configureApplication {\n    [[NSProcessInfo processInfo] setProcessName:self.appName];'
  if (!source.includes(configureNeedle)) {
    throw new Error('Unable to find configureApplication body for quit lifecycle patch.')
  }
  if (!source.includes('[NSApp setDelegate:self];')) {
    source = source.replace(
      configureNeedle,
      `${configureNeedle}\n    [NSApp setDelegate:self];`
    )
  }

  const quitLifecycleMethods = `// ${quitLifecycleMarker}: stop the Batshit runtime on every quit path.
- (void)showShutdownNotice {
    if (self.shutdownNoticeWindow) {
        return;
    }
    NSWindow *panel = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 380, 96)
                                                  styleMask:NSWindowStyleMaskTitled
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
    panel.title = self.appName.length > 0 ? self.appName : @"Batshit";
    panel.releasedWhenClosed = NO;
    panel.level = NSStatusWindowLevel;
    NSTextField *headline = [NSTextField labelWithString:@"Stopping Batshit services…"];
    headline.font = [NSFont boldSystemFontOfSize:14];
    [headline sizeToFit];
    headline.frame = NSMakeRect(20, 52, 340, headline.frame.size.height);
    [panel.contentView addSubview:headline];
    NSTextField *detail = [NSTextField labelWithString:@"Batshit will close by itself in a few seconds."];
    detail.font = [NSFont systemFontOfSize:12];
    detail.textColor = [NSColor secondaryLabelColor];
    [detail sizeToFit];
    detail.frame = NSMakeRect(20, 28, 340, detail.frame.size.height);
    [panel.contentView addSubview:detail];
    self.shutdownDetailLabel = detail;
    [panel center];
    [panel orderFrontRegardless];
    self.shutdownNoticeWindow = panel;
}

- (NSString *)shutdownCompletionMarkerPath {
    NSString *dataRoot = [NSProcessInfo processInfo].environment[@"BATSHIT_MAC_DATA_DIR"];
    if (dataRoot.length == 0) {
        NSString *applicationSupport = NSSearchPathForDirectoriesInDomains(
            NSApplicationSupportDirectory,
            NSUserDomainMask,
            YES
        ).firstObject;
        dataRoot = [applicationSupport stringByAppendingPathComponent:@"Batshit"];
    }
    return [[dataRoot stringByAppendingPathComponent:@"runtime"]
        stringByAppendingPathComponent:@"shutdown-complete.json"];
}

- (void)disconnectWebViewsForShutdown {
    [self removeAllChildBridgeHandlers];
    for (WKWebView *webView in self.childWebViews.allValues) {
        [webView stopLoading];
        webView.navigationDelegate = nil;
        webView.UIDelegate = nil;
        [webView removeFromSuperview];
    }
    [self.childWebViews removeAllObjects];
    [self.bridgeEnabledChildWebViewKeys removeAllObjects];

    for (WKWebView *webView in self.webViews.allValues) {
        [webView stopLoading];
        [webView.configuration.userContentController removeScriptMessageHandlerForName:@"zeroNativeBridge"];
        webView.navigationDelegate = nil;
        webView.UIDelegate = nil;
        [webView removeFromSuperview];
    }
    [self.webViews removeAllObjects];
    [self.bridgeScriptHandlers removeAllObjects];
    [self.assetSchemeHandlers removeAllObjects];
    self.webView = nil;
    self.bridgeScriptHandler = nil;
    self.assetSchemeHandler = nil;
}

- (void)beginAsynchronousShutdown {
    if (self.shutdownInProgress || self.shutdownFinished) {
        return;
    }
    self.shutdownInProgress = YES;
    for (NSWindow *window in self.windows.allValues) {
        [window orderOut:nil];
    }
    [self showShutdownNotice];
    [self disconnectWebViewsForShutdown];

    NSString *markerPath = [self shutdownCompletionMarkerPath];
    [[NSFileManager defaultManager] removeItemAtPath:markerPath error:nil];
    self.shutdownStartedAt = [NSDate date];
    [self emitShutdown];
    self.shutdownCompletionTimer = [NSTimer timerWithTimeInterval:0.1
                                                            target:self
                                                          selector:@selector(pollShutdownCompletion:)
                                                          userInfo:nil
                                                           repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:self.shutdownCompletionTimer forMode:NSRunLoopCommonModes];
}

- (void)failAsynchronousShutdown:(NSString *)message {
    [self.shutdownCompletionTimer invalidate];
    self.shutdownCompletionTimer = nil;
    self.shutdownInProgress = NO;
    self.shutdownDetailLabel.stringValue = message.length > 0
        ? message
        : @"Shutdown failed. Batshit remains open; check the runtime logs.";
    self.shutdownDetailLabel.textColor = [NSColor systemRedColor];
    [self.shutdownDetailLabel sizeToFit];
    [self.shutdownNoticeWindow orderFrontRegardless];
    [NSApp replyToApplicationShouldTerminate:NO];
}

- (void)pollShutdownCompletion:(NSTimer *)timer {
    NSString *markerPath = [self shutdownCompletionMarkerPath];
    if (![[NSFileManager defaultManager] fileExistsAtPath:markerPath]) {
        if (self.shutdownStartedAt && -[self.shutdownStartedAt timeIntervalSinceNow] > 120.0) {
            [self failAsynchronousShutdown:@"Shutdown timed out. Batshit remains open; check the runtime logs."];
        }
        return;
    }
    NSData *data = [NSData dataWithContentsOfFile:markerPath];
    NSError *jsonError = nil;
    NSDictionary *payload = data
        ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError]
        : nil;
    if (![payload isKindOfClass:[NSDictionary class]] || jsonError) {
        [self failAsynchronousShutdown:@"Shutdown returned an invalid completion record. Batshit remains open."];
        return;
    }
    if (![payload[@"ok"] boolValue]) {
        NSString *detail = [payload[@"error"] isKindOfClass:[NSString class]]
            ? payload[@"error"]
            : @"A managed service did not stop cleanly.";
        [self failAsynchronousShutdown:[NSString stringWithFormat:@"Shutdown failed: %@", detail]];
        return;
    }
    [timer invalidate];
    self.shutdownCompletionTimer = nil;
    self.shutdownInProgress = NO;
    self.shutdownFinished = YES;
    [NSApp replyToApplicationShouldTerminate:YES];
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    (void)sender;
    if (self.shutdownFinished) {
        return NSTerminateNow;
    }
    [self beginAsynchronousShutdown];
    return NSTerminateLater;
}

`
  const implementationAnchor = '- (void)configureApplication {'
  const previousQuitLifecycleMarker = previousQuitLifecycleMarkers.find((candidate) =>
    source.includes(candidate)
  )
  if (previousQuitLifecycleMarker || source.includes(legacyQuitLifecycleMarker)) {
    const existingMarker = previousQuitLifecycleMarker || legacyQuitLifecycleMarker
    const legacyStart = source.indexOf(existingMarker)
    const legacyEnd = source.indexOf(implementationAnchor, legacyStart)
    if (legacyEnd < 0) {
      throw new Error('Unable to replace legacy quit lifecycle patch.')
    }
    source = `${source.slice(0, legacyStart)}${quitLifecycleMethods}${source.slice(legacyEnd)}`
  } else {
    source = source.replace(implementationAnchor, `${quitLifecycleMethods}${implementationAnchor}`)
  }

  const windowCloseNeedle = `    if (self.host.windows.count == 0) {
        [self.host emitShutdown];
        [self.host stop];
    }`
  const legacyWindowCloseNeedle = `    if (self.host.windows.count == 0) {
        ZeroNativeAppKitHost *host = self.host;
        [host showShutdownNotice];
        dispatch_async(dispatch_get_main_queue(), ^{
            [host emitShutdown];
            [host stop];
        });
    }`
  const asyncWindowClose = `    if (self.host.windows.count == 0) {
        [NSApp terminate:nil];
    }`
  if (
    !source.includes(windowCloseNeedle) &&
    !source.includes(legacyWindowCloseNeedle) &&
    !source.includes(asyncWindowClose)
  ) {
    throw new Error('Unable to find last-window close handling for quit lifecycle patch.')
  }
  source = source.replace(windowCloseNeedle, asyncWindowClose)
  source = source.replace(legacyWindowCloseNeedle, asyncWindowClose)
}

if (source !== original) {
  // Packaging patch target is a pinned vendored Zero Native source path resolved earlier in this script.
  // codeql[js/file-system-race]
  fs.writeFileSync(appkitHostPath, source)
  console.log('[patch-zero-native] Applied macOS WKWebView file input/media capture/media playback/quit lifecycle patches.')
} else {
  console.log('[patch-zero-native] Zero Native macOS file input/media capture/media playback/quit lifecycle patches already present.')
}

let headerSource = fs.readFileSync(appkitHostHeaderPath, 'utf8')
const originalHeaderSource = headerSource

if (!headerSource.includes(webviewHeaderMarker)) {
  const insertionPoint = 'size_t zero_native_appkit_clipboard_read'
  const webviewDeclarations = `int zero_native_appkit_create_webview(zero_native_appkit_host_t *host, uint64_t window_id, const char *label, size_t label_len, const char *url, size_t url_len, double x, double y, double width, double height, int layer, int transparent, int bridge_enabled);
int zero_native_appkit_set_webview_frame(zero_native_appkit_host_t *host, uint64_t window_id, const char *label, size_t label_len, double x, double y, double width, double height);
int zero_native_appkit_navigate_webview(zero_native_appkit_host_t *host, uint64_t window_id, const char *label, size_t label_len, const char *url, size_t url_len);
int zero_native_appkit_set_webview_zoom(zero_native_appkit_host_t *host, uint64_t window_id, const char *label, size_t label_len, double zoom);
int zero_native_appkit_set_webview_layer(zero_native_appkit_host_t *host, uint64_t window_id, const char *label, size_t label_len, int layer);
int zero_native_appkit_close_webview(zero_native_appkit_host_t *host, uint64_t window_id, const char *label, size_t label_len);
`

  if (!headerSource.includes(insertionPoint)) {
    throw new Error('Unable to find webview declaration insertion point in Zero Native AppKit header.')
  }
  headerSource = headerSource.replace(insertionPoint, `${webviewDeclarations}${insertionPoint}`)
}

if (headerSource !== originalHeaderSource) {
  // Packaging patch target is a pinned vendored Zero Native header path resolved earlier in this script.
  // codeql[js/file-system-race]
  fs.writeFileSync(appkitHostHeaderPath, headerSource)
  console.log('[patch-zero-native] Applied macOS AppKit webview C-linkage header patch.')
} else {
  console.log('[patch-zero-native] Zero Native macOS AppKit webview header patch already present.')
}

if (!fs.existsSync(cefHostPath)) {
  throw new Error(`Zero Native CEF host source is missing: ${cefHostPath}`)
}

let cefSource = fs.readFileSync(cefHostPath, 'utf8')
const originalCefSource = cefSource

if (!cefSource.includes(cefMathMarker)) {
  const insertionPoint = '#include <string.h>\n\n#include "include/cef_app.h"'
  const mathMacroCompat = `#include <string.h>

// BATSHIT_CEF_MATH_MACRO_COMPAT
// macOS SDK C math macros can leak through AppKit before CEF pulls in C++ <cmath>
// through libc++. Undefine the C macros before the CEF C++ headers are parsed.
#ifdef __cplusplus
#ifdef fpclassify
#undef fpclassify
#endif
#ifdef isfinite
#undef isfinite
#endif
#ifdef isinf
#undef isinf
#endif
#ifdef isnan
#undef isnan
#endif
#ifdef isnormal
#undef isnormal
#endif
#ifdef signbit
#undef signbit
#endif
#endif

#include "include/cef_app.h"`

  if (!cefSource.includes(insertionPoint)) {
    throw new Error('Unable to find CEF include insertion point in Zero Native macOS CEF host.')
  }
  cefSource = cefSource.replace(insertionPoint, mathMacroCompat)
}

if (cefSource !== originalCefSource) {
  // Packaging patch target is a pinned vendored Zero Native CEF source path resolved earlier in this script.
  // codeql[js/file-system-race]
  fs.writeFileSync(cefHostPath, cefSource)
  console.log('[patch-zero-native] Applied macOS CEF ObjC++ math macro compatibility patch.')
} else {
  console.log('[patch-zero-native] Zero Native macOS CEF compatibility patch already present.')
}
