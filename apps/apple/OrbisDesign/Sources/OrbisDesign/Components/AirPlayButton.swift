import AVKit
import SwiftUI

public struct AirPlayButton: View {
  public init() {}

  public var body: some View {
    RoutePicker()
      .frame(width: 44, height: 44)
      .accessibilityLabel("AirPlay")
      .accessibilityIdentifier("airplay")
  }
}

#if os(macOS)
  private struct RoutePicker: NSViewRepresentable {
    func makeNSView(context: Context) -> AVRoutePickerView {
      let picker = AVRoutePickerView()
      picker.isRoutePickerButtonBordered = false
      picker.setRoutePickerButtonColor(NSColor(Color.orbis.tint), for: .activeHighlighted)
      picker.setRoutePickerButtonColor(NSColor(Color.orbis.tint), for: .active)
      return picker
    }

    func updateNSView(_ picker: AVRoutePickerView, context: Context) {}
  }
#else
  private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
      let picker = AVRoutePickerView()
      picker.prioritizesVideoDevices = false
      picker.activeTintColor = UIColor(Color.orbis.tint)
      picker.tintColor = .label
      return picker
    }

    func updateUIView(_ picker: AVRoutePickerView, context: Context) {}
  }
#endif

#Preview("AirPlay") {
  AirPlayButton()
    .padding()
    .background(Color.orbis.paper)
}
