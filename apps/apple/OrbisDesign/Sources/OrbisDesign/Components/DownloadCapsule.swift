import SwiftUI

public struct DownloadCapsule: View {
  public enum Phase: Equatable, Sendable {
    case available
    case queued
    case downloading(Double?)
    case failed
  }

  public let phase: Phase
  public let start: () -> Void
  public let cancel: () -> Void

  public init(phase: Phase, start: @escaping () -> Void, cancel: @escaping () -> Void) {
    self.phase = phase
    self.start = start
    self.cancel = cancel
  }

  public static func fill(for phase: Phase) -> Double {
    switch phase {
    case .available, .failed: 1
    case .queued: 0
    case .downloading(let fraction): min(max(fraction ?? 0, 0), 1)
    }
  }

  public static func label(for phase: Phase) -> String {
    switch phase {
    case .available: "Download"
    case .failed: "Retry Download"
    case .queued: "Waiting to download"
    case .downloading(let fraction?): "Downloading \(Int((fraction * 100).rounded()))%"
    case .downloading(nil): "Downloading"
    }
  }

  private var isWorking: Bool {
    switch phase {
    case .queued, .downloading: true
    case .available, .failed: false
    }
  }

  public var body: some View {
    ZStack {
      Capsule().fill(.quaternary)
      GeometryReader { proxy in
        Capsule()
          .fill(Color.orbis.tint.opacity(isWorking ? 0.55 : 1))
          .frame(width: proxy.size.width * Self.fill(for: phase))
      }
      HStack(spacing: 10) {
        if isWorking {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: phase == .failed ? "arrow.clockwise" : "arrow.down")
            .fontWeight(.semibold)
        }
        Text(Self.label(for: phase))
          .font(.orbis.body.weight(.semibold))
          .monospacedDigit()
          .contentTransition(.numericText())
      }
      .foregroundStyle(isWorking ? AnyShapeStyle(.primary) : AnyShapeStyle(.white))
      .frame(maxWidth: .infinity)
      if isWorking {
        HStack {
          Spacer()
          Button("Cancel Download", systemImage: "xmark", action: cancel)
            .labelStyle(.iconOnly)
            .font(.body.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: 44, height: 44)
            .contentShape(.rect)
            .buttonStyle(.plain)
            .accessibilityIdentifier("detail-cancel-download")
        }
        .padding(.trailing, 4)
      }
    }
    .frame(height: 52)
    .frame(maxWidth: 420)
    .clipShape(.capsule)
    .contentShape(.capsule)
    .onTapGesture { if !isWorking { start() } }
    .orbisAnimation(.downloadProgressed, value: phase)
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(isWorking ? [] : .isButton)
    .accessibilityLabel(Self.label(for: phase))
    .accessibilityAction { if !isWorking { start() } }
    .accessibilityIdentifier(phase == .failed ? "detail-retry-download" : "detail-download")
  }
}

#Preview("Download capsule") {
  VStack(spacing: 16) {
    DownloadCapsule(phase: .available, start: {}, cancel: {})
    DownloadCapsule(phase: .queued, start: {}, cancel: {})
    DownloadCapsule(phase: .downloading(0.42), start: {}, cancel: {})
    DownloadCapsule(phase: .failed, start: {}, cancel: {})
  }
  .padding()
  .background(Color.orbis.paper)
  .preferredColorScheme(.dark)
}
