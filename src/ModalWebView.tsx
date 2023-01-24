import * as React from 'react';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useAppState } from '@react-native-community/hooks';
import { Animated, StyleSheet, View } from 'react-native';
import { injectJavaScriptIntoWebViewBeforeIsLoaded } from './api';
import { WebView as RNWebView } from 'react-native-webview';
import { CHAT_PAGE, LOGIN_PAGE, USER_AGENT } from './constants';
import { ChatGpt3Response, ChatGPTError, WebViewEvents } from './types';
import { parseStreamBasedResponse, wait } from './utils';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useWebViewAnimation } from './hooks';

interface Props {
  accessToken: string;
  webviewRef: React.RefObject<RNWebView>;
  onAccessTokenChange: (newAccessToken: string) => void;
  onPartialResponse: (response: ChatGpt3Response) => void;
  onStreamError: (error: ChatGPTError) => void;
}

export interface ModalWebViewMethods {
  open: () => void;
}

const ModalWebView = forwardRef<ModalWebViewMethods, Props>(
  (
    {
      accessToken,
      onAccessTokenChange,
      onPartialResponse,
      onStreamError,
      webviewRef,
    },
    ref
  ) => {
    const currentAppState = useAppState();
    const [status, setStatus] = useState<'hidden' | 'animating' | 'visible'>(
      'hidden'
    );

    const { animatedStyles, animateWebView } = useWebViewAnimation({
      onAnimationStart: () => setStatus('animating'),
      onAnimationEnd: (mode) =>
        setStatus(mode === 'show' ? 'visible' : 'hidden'),
    });

    useImperativeHandle(ref, () => ({
      open: () => {
        animateWebView('show');
      },
    }));

    useEffect(() => {
      if (status === 'visible') {
        // Check if the page shown is ChatGPT3 is at full capacity.
        // If it is, we can reload the page at intervals to check if it's available again.
        checkIfChatGPTIsAtFullCapacity();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);

    useEffect(() => {
      // Every time the app is brought to the foreground,
      // we reload the webview to avoid 403s from Cloudfare on the chat screen
      if (currentAppState === 'active') {
        webviewRef.current?.reload();
      }
    }, [currentAppState, webviewRef]);

    function checkIfChatGPTIsAtFullCapacity() {
      const script = `
        const xpath = "//div[contains(text(),'ChatGPT is at capacity right now')]";
        const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (element) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'GPT3_FULL_CAPACITY' }));
        }

        true;
      `;
      webviewRef.current?.injectJavaScript(script);
    }

    async function reloadAndCheckCapacityAgain() {
      await wait(2000);
      webviewRef.current?.reload();
      await wait(3000);
      checkIfChatGPTIsAtFullCapacity();
    }

    return (
      <>
        <Animated.View style={[styles.container, animatedStyles.webview]}>
          <RNWebView
            injectedJavaScriptBeforeContentLoaded={injectJavaScriptIntoWebViewBeforeIsLoaded()}
            ref={webviewRef}
            style={styles.webview}
            source={{ uri: status === 'hidden' ? CHAT_PAGE : LOGIN_PAGE }}
            onNavigationStateChange={(event) => {
              if (event.url.startsWith(CHAT_PAGE) && event.loading) {
                // We have successfully logged in, or we were already logged in.
                // We can hide the webview now.
                if (status === 'visible') {
                  animateWebView('hide');
                }
              }
            }}
            userAgent={USER_AGENT}
            sharedCookiesEnabled
            onMessage={(event) => {
              try {
                const { payload, type } = JSON.parse(
                  event.nativeEvent.data
                ) as WebViewEvents;
                if (type === 'REQUEST_INTERCEPTED_CONFIG') {
                  if (Object.keys(payload)) {
                    // We have headers
                    const { headers } = payload;
                    if (headers && 'Authorization' in headers) {
                      const newAuthToken = headers?.Authorization;
                      if (!!newAuthToken && newAuthToken !== accessToken) {
                        onAccessTokenChange(newAuthToken);
                      }
                    }
                  }
                }
                if (type === 'RAW_PARTIAL_RESPONSE') {
                  const result = parseStreamBasedResponse(payload);
                  if (result) {
                    onPartialResponse(result);
                  }
                }
                if (type === 'GPT3_FULL_CAPACITY' && status === 'visible') {
                  // Reload the page to check if it's available again.
                  reloadAndCheckCapacityAgain();
                }
                if (type === 'STREAM_ERROR') {
                  const error = new ChatGPTError(
                    payload?.statusText ||
                      `ChatGPTResponseStreamError: ${payload?.status}`
                  );
                  error.statusCode = payload?.status;
                  onStreamError(error);
                }
              } catch (e) {
                // Ignore errors here
              }
            }}
          />
          <View style={styles.closeButton}>
            <Icon
              name="close"
              color="black"
              size={32}
              onPress={() => animateWebView('hide')}
            />
          </View>
        </Animated.View>
        <Animated.View
          style={[styles.backdrop, animatedStyles.backdrop]}
          pointerEvents="none"
        />
      </>
    );
  }
);

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  container: {
    position: 'absolute',
    // Needed for Android to be on top of everything else
    elevation: 8,
    zIndex: 100,
    top: 96,
    left: 16,
    right: 16,
    bottom: 96,
    borderRadius: 16,
    overflow: 'hidden',
    flex: 1,
    shadowColor: 'black',
    shadowOffset: {
      width: 4,
      height: 4,
    },
    shadowOpacity: 0.25,
    shadowRadius: 10,
  },
  closeButton: {
    position: 'absolute',
    top: 16,
    right: 16,
  },
  webview: {
    flex: 1,
    backgroundColor: 'white',
    borderRadius: 16,
  },
});

export default ModalWebView;
