declare module "qrcode-terminal" {
  const qrcode: {
    generate(text: string, options: { small?: boolean }, callback: (code: string) => void): void;
  };
  export default qrcode;
}
