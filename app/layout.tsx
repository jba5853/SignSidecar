export const metadata = {
  title: "SignSidecar",
  description: "ASL fingerspelling & gesture → voice sidecar",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900">
        <main className="max-w-4xl mx-auto p-4 md:p-6">{children}</main>
      </body>
    </html>
  );
}
