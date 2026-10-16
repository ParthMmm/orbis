import OrbisDesign
import SwiftUI

/// A failure's sentence and the way to copy its details, as rows of the section that failed.
struct FailureRows: View {
  let failure: OrbisFailure?
  let context: String
  let identifier: String

  var body: some View {
    if let failure {
      Text(failure.message)
        .foregroundStyle(OrbisColor.destructive)
        .accessibilityIdentifier(identifier)
      CopyFailureButton(report: FailureReport(failure: failure, context: context))
    }
  }
}

/// A Sign-in Code, large enough to read across a room, with when it stops working.
struct SignInCodeView: View {
  let code: SignInCode
  let identifier: String

  var body: some View {
    VStack(spacing: 6) {
      HStack(spacing: 12) {
        Text(code.formatted)
          .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
          #if !os(tvOS)
            .textSelection(.enabled)
          #endif
          .accessibilityIdentifier(identifier)
        #if !os(tvOS)
          CopyButton(title: "Copy Code", text: code.code, identifier: "\(identifier)-copy")
            .font(.title3)
        #endif
      }
      Text("Works once, until \(SetPresentation.date(from: code.expiresAt), style: .time).")
        .font(.orbis.detail)
        .foregroundStyle(OrbisColor.muted)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
  }
}

/// A copy symbol that puts `text` on the clipboard and turns into a checkmark for a moment. The
/// title is what VoiceOver reads; the text itself never shows. With a `row` name, the whole row
/// is the button, so tapping the name copies too.
struct CopyButton: View {
  let title: String
  let text: String
  let identifier: String
  var row: String?
  @State private var copied = false

  var body: some View {
    Button {
      copyToPasteboard(text)
      copied = true
    } label: {
      if let row {
        LabeledContent {
          symbol
        } label: {
          Text(row).foregroundStyle(Color.primary)
        }
      } else {
        // The symbol alone is smaller than a finger, so its tap area is the 44-point minimum.
        symbol
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
      }
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(copied ? "Copied" : title)
    .sensoryFeedback(.success, trigger: copied) { _, now in now }
    .task(id: copied) {
      guard copied else { return }
      try? await Task.sleep(for: .seconds(2))
      copied = false
    }
    .accessibilityIdentifier(identifier)
  }

  /// Sized by the copy symbol, the wider of the two, so the checkmark does not move what sits
  /// beside it.
  private var symbol: some View {
    Image(systemName: "doc.on.doc")
      .hidden()
      .overlay {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
          .foregroundStyle(Color.orbis.tint)
          .contentTransition(.symbolEffect(.replace))
      }
  }
}
