// Type shim: 'react-native' resolves to react-native-web at runtime via Vite alias.
// Declarations here satisfy TypeScript without touching V3 component code.
declare module 'react-native' {
  import type * as React from 'react';

  // Declare component instance interfaces extending React.Component so that
  // useRef<View> and useRef<ScrollView> are assignable to component refs.
  export interface View extends React.Component<any, any, any> {}
  export interface ScrollView extends React.Component<any, any, any> {
    scrollToEnd(options?: { animated?: boolean }): void;
    scrollTo(options?: { x?: number; y?: number; animated?: boolean }): void;
  }
  export interface TextInput extends React.Component<any, any, any> {
    focus(): void;
    blur(): void;
    clear(): void;
  }
  export interface FlatList<T = any> extends React.Component<any, any, any> {}
  export interface SectionList<T = any> extends React.Component<any, any, any> {}
  export interface Image extends React.Component<any, any, any> {}
  export interface Modal extends React.Component<any, any, any> {}

  // Component constructors
  export const View: React.ComponentClass<any>;
  export const Text: React.ComponentClass<any>;
  export const TextInput: React.ComponentClass<any>;
  export const Pressable: React.ComponentClass<any>;
  export const ScrollView: React.ComponentClass<any>;
  export const FlatList: React.ComponentClass<any>;
  export const SectionList: React.ComponentClass<any>;
  export const Image: React.ComponentClass<any>;
  export const TouchableOpacity: React.ComponentClass<any>;
  export const TouchableHighlight: React.ComponentClass<any>;
  export const Modal: React.ComponentClass<any>;
  export const ActivityIndicator: React.ComponentClass<any>;
  export const KeyboardAvoidingView: React.ComponentClass<any>;
  export const SafeAreaView: React.ComponentClass<any>;

  // Non-component exports
  export const StyleSheet: any;
  export const Platform: any;
  export const Animated: any;
  export const AppRegistry: any;
  export const Alert: any;
  export const Dimensions: any;

  // Types
  export type ViewStyle = any;
  export type TextStyle = any;
  export type ImageStyle = any;
  export type PressableProps = any;
  export type ViewProps = any;
  export type TextProps = any;
  export type StyleProp<T> = any;
  export type GestureResponderEvent = any;
  export type NativeSyntheticEvent<T> = any;
  export type TextInputChangeEventData = any;
}
