import { useRef } from 'react';
import { Animated, Dimensions } from 'react-native';

interface Arguments {
  onAnimationStart?: (mode: 'hide' | 'show') => void;
  onAnimationEnd?: (mode: 'hide' | 'show') => void;
}

export function useWebViewAnimation({
  onAnimationStart,
  onAnimationEnd,
}: Arguments) {
  const animatedValue = useRef(new Animated.Value(0));
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
  const backdropOpacity = animatedValue.current.interpolate({
    inputRange: [0, 0.8, 1],
    outputRange: [0, 0.5, 0.5],
  });

  const animateWebView = (mode: 'hide' | 'show') => {
    onAnimationStart?.(mode);
    Animated.timing(animatedValue.current, {
      toValue: mode === 'show' ? 1 : 0,
      duration: 500,
      useNativeDriver: true,
    }).start(() => {
      onAnimationEnd?.(mode);
    });
  };

  return {
    animatedStyles: {
      webview: {
        opacity,
        transform: [{ translateY }, { scale }],
      },
      backdrop: {
        opacity: backdropOpacity,
      },
    },
    animateWebView,
  };
}
