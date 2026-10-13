use encoding_rs::{DecoderResult, Encoding, UTF_8};

#[derive(Debug, PartialEq, Eq)]
pub enum TextError {
    Binary,
    Encoding,
}

/// UTF-8 or BOM-declared UTF-16. Never guess a legacy encoding or silently replace data.
/// An incomplete trailing character is buffered, not replaced, for a preview prefix.
pub fn decode_text(bytes: &[u8], truncated: bool) -> Result<String, TextError> {
    let (encoding, offset) = Encoding::for_bom(bytes).unwrap_or((UTF_8, 0));
    let data = &bytes[offset..];
    if offset == 0 {
        let sample = &data[..data.len().min(8192)];
        if sample.contains(&0) || content_inspector::inspect(sample).is_binary() {
            return Err(TextError::Binary);
        }
    }
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length_without_replacement(data.len())
        .ok_or(TextError::Encoding)?;
    let mut output = String::with_capacity(capacity);
    let (result, _) = decoder.decode_to_string_without_replacement(data, &mut output, !truncated);
    match result {
        DecoderResult::InputEmpty if !output.contains('\0') => Ok(output),
        DecoderResult::InputEmpty => Err(TextError::Binary),
        _ => Err(TextError::Encoding),
    }
}

pub fn markdown_fence(content: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for byte in content.bytes() {
        run = if byte == b'`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    "`".repeat(3.max(longest + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_bom_and_invalid_bytes() {
        assert_eq!(decode_text(b"\xef\xbb\xbfhello", false), Ok("hello".into()));
        assert_eq!(decode_text(b"caf\xe9", false), Err(TextError::Encoding));
        assert_eq!(decode_text(b"\xff\xfeA", false), Err(TextError::Encoding));
        assert_eq!(decode_text(b"a\0b", false), Err(TextError::Binary));
    }

    #[test]
    fn truncated_unicode_never_adds_replacement_characters() {
        assert_eq!(decode_text(b"a\xf0\x9f", true), Ok("a".into()));
        assert_eq!(
            decode_text(&[0xff, 0xfe, b'a', 0, 0x3d, 0xd8], true),
            Ok("a".into())
        );
        assert_eq!(
            decode_text(&[0xff, 0xfe, b'a', 0, b'b'], true),
            Ok("a".into())
        );
    }
}
