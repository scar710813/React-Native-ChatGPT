import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Animated, Dimensions, StyleSheet, View } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { WebView } from 'react-native-webview';
import {
  CHAT_PAGE,
  ChatGpt3Response,
  ChatGPTError,
  HOST_URL,
  LOGIN_PAGE,
  parseStreamBasedResponse,
  PROMPT_ENDPOINT,
  sendMessage,
  usePrevious,
  USER_AGENT,
} from './utils';
import uuid from 'react-native-uuid';

type WebViewEvents =
  | {
      type: 'REQUEST_INTERCEPTED_CONFIG';
      payload: RequestInit;
    }
  | {
      type: 'RAW_PARTIAL_RESPONSE';
      payload: string;
    }
  | {
      type: 'STREAM_ERROR';
      payload: {
        status: number;
        statusText: string;
      };
    };

type MessageOptions = {
  conversationId?: string;
  messageId?: string;
};

interface PartialResponseArgs {
  message: string;
  options?: MessageOptions;
  onPartialResponse?: (arg: ChatGpt3Response) => void;
  onError?: (arg: ChatGPTError) => void;
}

interface ChatGpt3ContextInterface {
  accessToken: string;
  login: () => void;
  sendMessage(
    message: string,
    options?: MessageOptions
  ): Promise<ChatGpt3Response>;
  sendMessage(args: PartialResponseArgs): void;
}

const ChatGpt3Context = createContext<ChatGpt3ContextInterface>(
  undefined as unknown as ChatGpt3ContextInterface
);

export const useChatGpt3 = () => useContext(ChatGpt3Context);

export default function ChatGpt3({
  children,
}: {
  children?: ReactNode | undefined;
}) {
  const animatedValue = useRef(new Animated.Value(0));
  const webviewRef = useRef<WebView>(null);
  const [accessToken, setAccessToken] = useState('');
  const [status, setStatus] = useState<'hidden' | 'animating' | 'visible'>(
    'hidden'
  );
  const prevStatus = usePrevious(status);
  const callbackRef = useRef<(arg: ChatGpt3Response) => void>(() => null);
  const errorCallbackRef = useRef<(arg: ChatGPTError) => void>(() => null);

  const translateY = animatedValue.current.interpolate({
    inputRange: [0, 1],
    outputRange: [Dimensions.get('window').height, 0],
    extrapolate: 'clamp',
  });
  const opacity = animatedValue.current.interpolate({
    inputRange: [0, 0.8, 1],
    outputRange: [0, 0, 1],
    extrapolate: 'clamp',
  });
  const scale = animatedValue.current.interpolate({
    inputRange: [0, 0.01, 0.02, 1],
    outputRange: [0, 0, 1, 1],
  });

  const animateWebView = (mode: 'hide' | 'show') => {
    setStatus('animating');
    Animated.timing(animatedValue.current, {
      toValue: mode === 'show' ? 1 : 0,
      duration: 500,
      useNativeDriver: true,
    }).start(() => {
      setStatus(mode === 'show' ? 'visible' : 'hidden');
    });
  };

  useEffect(() => {
    if (prevStatus === 'hidden' && status === 'animating') {
      animateWebView('show');
    } else if (prevStatus === 'visible' && status === 'animating') {
      animateWebView('hide');
    }
  }, [prevStatus, status]);

  const login = () => {
    setStatus('animating');
    setAccessToken('');
  };

  const contextValue = useMemo(
    () => ({
      accessToken,
      login,
      sendMessage: (
        ...args: [PartialResponseArgs] | [string, MessageOptions?]
      ) => {
        if (typeof args[0] === 'string') {
          const message = args[0];
          const options = args[1];
          return sendMessage({
            accessToken,
            message,
            conversationId: options?.conversationId,
            messageId: options?.messageId,
          });
        }

        const { message, options, onPartialResponse, onError } = args[0];

        if (onPartialResponse) {
          callbackRef.current = onPartialResponse;
          errorCallbackRef.current = onError || (() => null);

          const runJavaScript = `
            window.sendGptMessage({
              accessToken: "${accessToken}",
              message: "${message}",
              messageId: "${options?.messageId || uuid.v4()}",
              conversationId: "${options?.conversationId || uuid.v4()}"
            });

            true;
          `;

          // Stream based response
          webviewRef.current?.injectJavaScript(runJavaScript);
          return undefined;
        }

        return;
      },
    }),
    [accessToken]
  );

  // Intercept fetch requests to extract the access token
  const runFirst = `
    const { fetch: originalFetch } = window;
    window.fetch = async (...args) => {
      const [resource, config] = args;
      window.ReactNativeWebView.postMessage(JSON.stringify({type: 'REQUEST_INTERCEPTED_CONFIG', payload: config}));
      const response = await originalFetch(resource, config);
      return response;
    };

    window.sendGptMessage = async ({
      accessToken,
      message,
      messageId,
      conversationId
    }) => {

      async function* streamAsyncIterable(stream) {
        const reader = stream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              return
            }
            yield value
          }
        } finally {
          reader.releaseLock()
        }
      }

      function getHeaders(accessToken) {
        return {
          accept: "text/event-stream",
          "x-openai-assistant-app-id": "",
          authorization: accessToken,
          "content-type": "application/json",
          origin: "${HOST_URL}",
          referrer: "${CHAT_PAGE}",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "x-requested-with": "com.chatgpt3auth"
        };
      }

      const url = "${PROMPT_ENDPOINT}";
      const body = {
        action: "next",
        messages: [
          {
            id: conversationId,
            role: "user",
            content: {
              content_type: "text",
              parts: [message],
            },
          },
        ],
        model: "text-davinci-002-render",
        parent_message_id: messageId,
      };

      const headers = getHeaders(accessToken);

      try {
        const res = await fetch(url, {
          method: "POST",
          body: JSON.stringify(body),
          headers: headers,
          mode: "cors",
          credentials: "include"
        });

        if (res.status >= 400 && res.status < 600) {
          return window.ReactNativeWebView.postMessage(JSON.stringify({type: 'STREAM_ERROR', payload: {status: res.status, message: res.statusText}}));
        }

        for await (const chunk of streamAsyncIterable(res.body)) {
          const str = new TextDecoder().decode(chunk);
          window.ReactNativeWebView.postMessage(JSON.stringify({type: 'RAW_PARTIAL_RESPONSE', payload: str}));
        }
      } catch (e) {
        console.log("error", e);
      }
    };

    true;
  `;

  return (
    <View style={{ flex: 1 }}>
      {/* @ts-ignore */}
      <ChatGpt3Context.Provider value={contextValue}>
        <Animated.View
          style={[
            styles.container,
            {
              opacity,
              transform: [
                {
                  translateY,
                },
                {
                  scale,
                },
              ],
            },
          ]}
        >
          <WebView
            injectedJavaScriptBeforeContentLoaded={runFirst}
            ref={webviewRef}
            style={{ flex: 1, backgroundColor: 'white' }}
            source={{ uri: status === 'hidden' ? CHAT_PAGE : LOGIN_PAGE }}
            onNavigationStateChange={(event) => {
              if (event.url === CHAT_PAGE && event.loading) {
                // We have successfully logged in, or we were already logged in.
                // We can hide the webview now.
                if (status === 'visible') {
                  setStatus('animating');
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
                  if (accessToken) {
                    // We already have the access token, no need to do anything
                    return;
                  }
                  if (Object.keys(payload)) {
                    // We have headers
                    const { headers } = payload;
                    if (headers && 'Authorization' in headers) {
                      const authToken = headers?.Authorization;
                      setAccessToken(authToken as string);
                    }
                  }
                }
                if (type === 'RAW_PARTIAL_RESPONSE') {
                  const result = parseStreamBasedResponse(payload);
                  if (result) {
                    callbackRef.current?.(result);
                  }
                }
                if (type === 'STREAM_ERROR') {
                  const error = new ChatGPTError(
                    payload?.statusText || 'Unknown error'
                  );
                  error.statusCode = payload?.status;
                  errorCallbackRef.current?.(error);
                }
              } catch (e) {
                console.log('error', e);
              }
            }}
          />
          <View style={styles.closeButton}>
            <Icon
              name="close"
              color="black"
              size={24}
              onPress={() => setStatus('animating')}
            />
          </View>
        </Animated.View>
        {children}
      </ChatGpt3Context.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    // Needed for Android to be on top of everything else
    elevation: 8,
    zIndex: 100,
    top: 96,
    left: 32,
    right: 32,
    bottom: 96,
    borderRadius: 16,
    overflow: 'hidden',
    flex: 1,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  closeButton: {
    position: 'absolute',
    top: 16,
    right: 16,
  },
});
