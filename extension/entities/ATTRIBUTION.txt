---
license: apache-2.0
datasets:
- gravitee-io/pii-detection-dataset
language:
- en
base_model:
- prajjwal1/bert-small
pipeline_tag: token-classification
tags:
  - pii
  - ner
  - token-classification
  - privacy
  - ai-gateway
---
# gravitee-io/bert-small-pii-detection 🚀

Token-classification model for PII detection, fine-tuned from `prajjwal1/bert-small` on
[`gravitee-io/pii-detection-dataset`](https://huggingface.co/datasets/gravitee-io/pii-detection-dataset).

### Label Set

```
AGE, COORDINATE, CREDIT_CARD, DATE_TIME, EMAIL_ADDRESS, FINANCIAL, HONORIFIC, IBAN_CODE, IMEI,
IP_ADDRESS, LOCATION, MAC_ADDRESS, NRP, ORGANIZATION, PASSWORD, PERSON, PHONE_NUMBER,
TITLE, URL, US_BANK_NUMBER, US_DRIVER_LICENSE, US_ITIN, US_LICENSE_PLATE, US_PASSPORT, US_SSN
```

## How to Use

### Quick start (pipeline)

```python
from transformers import AutoTokenizer, AutoModelForTokenClassification, pipeline

repo = "gravitee-io/bert-small-pii-detection"
tok = AutoTokenizer.from_pretrained(repo)
model = AutoModelForTokenClassification.from_pretrained(repo)

pipe = pipeline("token-classification", model=model, tokenizer=tok, aggregation_strategy="simple")
text = "Contact John Smith at john@example.com"
pipe(text)
```

### ONNX

```commandline
pip install transformers onnxruntime huggingface_hub 
```

```python
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer, AutoConfig
import onnxruntime as ort

model_id = "gravitee-io/bert-small-pii-detection"

tokenizer = AutoTokenizer.from_pretrained(model_id)
id2label = AutoConfig.from_pretrained(model_id).id2label
session = ort.InferenceSession(hf_hub_download(model_id, "model.quant.onnx"))

text = "Contact John Smith at john@example.com"
enc = tokenizer(text, return_tensors="np")
inputs = {"input_ids": enc["input_ids"], "attention_mask": enc["attention_mask"]}
logits = session.run(None, inputs)[0][0]

tokens = tokenizer.convert_ids_to_tokens(enc["input_ids"][0])
labels = [id2label[i] for i in logits.argmax(-1)]

for tok, label in zip(tokens, labels):
  print(f"{tok:<20} {label}")
```

## Intended use

Detect personally identifiable information (PII) spans in `english` text. Suitable
for privacy filtering, redaction pipelines, and data-leak prevention particularly on
structured data (JSON, HTML, XML, SQL, Document)

## Evaluation

| Metric | Value |
|---|---|
| F1 | 0.8686 |
| Precision | 0.8182 |
| Recall | 0.9256 |
| Eval loss | 0.0132 |


## Limitations

* English-focused; other languages will degrade
* Domain drift is real: audit on your own data
---

## Benchmarks

External-corpus evaluation (English only), seqeval. Last run: 2026-05-21.

| Benchmark                                          | Examples | FP32 micro F1 | FP32 macro F1 | INT8 micro F1 | INT8 macro F1 |
|----------------------------------------------------|---:|---:|---:|---:|---:|
| `gretelai/gretel-pii-masking-en-v1:test`           | 5,000 | 0.9141 | 0.8971 | 0.9121 | 0.8860 |
| `gretelai/synthetic_pii_finance_multilingual:test` | 2,962 | 0.7534 | 0.7354 | 0.7498 | 0.7351 |
| `DataikuNLP/kiji-pii-training-data:test`           | 1,033 | 0.9259 | 0.8685 | 0.9265 | 0.8725 |
| `beki/privy:test`                                  | 28,843 | 0.8809 | 0.9694 | 0.8800 | 0.9680 |
| `beki/privy:test-large`                            | 120,574 | 0.9833 | 0.9810 | 0.9825 | 0.9801 |

### Per-entity breakdown

<details>
<summary><code>gretelai/gretel-pii-masking-en-v1:test</code></summary>

| Entity | FP32 F1 | FP32 P / R | Support | INT8 F1 | INT8 P / R |
|---|---:|---|---:|---:|---|
| `AGE` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `COORDINATE` | 0.8966 | 0.876 / 0.918 | 85 | 0.8966 | 0.876 / 0.918 |
| `CREDIT_CARD` | 0.9572 | 0.937 / 0.979 | 663 | 0.9524 | 0.926 / 0.980 |
| `DATE_TIME` | 0.9605 | 0.935 / 0.988 | 3,805 | 0.9568 | 0.929 / 0.987 |
| `EMAIL_ADDRESS` | 0.9854 | 0.976 / 0.995 | 1,048 | 0.9854 | 0.976 / 0.995 |
| `FINANCIAL` | 0.7143 | 0.641 / 0.806 | 31 | 0.6857 | 0.615 / 0.774 |
| `IMEI` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `IP_ADDRESS` | 0.9819 | 0.974 / 0.990 | 961 | 0.9829 | 0.976 / 0.990 |
| `LOCATION` | 0.8549 | 0.853 / 0.857 | 1,760 | 0.8561 | 0.855 / 0.857 |
| `NRP` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `ORGANIZATION` | 0.7159 | 0.611 / 0.865 | 185 | 0.6974 | 0.587 / 0.859 |
| `PASSWORD` | 0.8712 | 0.793 / 0.966 | 119 | 0.8679 | 0.788 / 0.966 |
| `PERSON` | 0.7973 | 0.781 / 0.814 | 3,209 | 0.7948 | 0.781 / 0.809 |
| `PHONE_NUMBER` | 0.9738 | 0.962 / 0.986 | 904 | 0.9701 | 0.955 / 0.986 |
| `TITLE` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `URL` | 0.8846 | 0.793 / 1.000 | 23 | 0.8302 | 0.733 / 0.957 |
| `US_BANK_NUMBER` | 0.9610 | 0.962 / 0.960 | 398 | 0.9611 | 0.960 / 0.962 |
| `US_DRIVER_LICENSE` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `US_ITIN` | 0.8936 | 0.875 / 0.913 | 23 | 0.8333 | 0.800 / 0.870 |
| `US_LICENSE_PLATE` | 0.9171 | 0.873 / 0.965 | 579 | 0.9156 | 0.871 / 0.965 |
| `US_PASSPORT` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `US_SSN` | 0.9880 | 0.985 / 0.991 | 1,705 | 0.9898 | 0.988 / 0.992 |

</details>

<details>
<summary><code>gretelai/synthetic_pii_finance_multilingual:test</code></summary>

| Entity | FP32 F1 | FP32 P / R | Support | INT8 F1 | INT8 P / R |
|---|---:|---|---:|---:|---|
| `AGE` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `COORDINATE` | 0.6000 | 0.483 / 0.792 | 53 | 0.6087 | 0.494 / 0.792 |
| `CREDIT_CARD` | 0.5874 | 0.467 / 0.792 | 53 | 0.6143 | 0.494 / 0.811 |
| `DATE_TIME` | 0.7410 | 0.667 / 0.833 | 4,294 | 0.7406 | 0.667 / 0.833 |
| `EMAIL_ADDRESS` | 0.7971 | 0.746 / 0.856 | 576 | 0.7981 | 0.741 / 0.865 |
| `FINANCIAL` | 0.7048 | 0.632 / 0.796 | 294 | 0.6967 | 0.624 / 0.789 |
| `IBAN_CODE` | 0.8514 | 0.778 / 0.940 | 67 | 0.8571 | 0.787 / 0.940 |
| `IP_ADDRESS` | 0.7854 | 0.796 / 0.775 | 111 | 0.7892 | 0.786 / 0.793 |
| `LOCATION` | 0.7554 | 0.684 / 0.844 | 1,938 | 0.7506 | 0.677 / 0.842 |
| `NRP` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `ORGANIZATION` | 0.6975 | 0.612 / 0.811 | 2,702 | 0.6876 | 0.602 / 0.802 |
| `PASSWORD` | 0.6392 | 0.508 / 0.861 | 36 | 0.5941 | 0.462 / 0.833 |
| `PERSON` | 0.8125 | 0.778 / 0.851 | 3,295 | 0.8085 | 0.771 / 0.850 |
| `PHONE_NUMBER` | 0.8648 | 0.791 / 0.953 | 406 | 0.8651 | 0.790 / 0.956 |
| `TITLE` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `URL` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `US_BANK_NUMBER` | 0.6038 | 0.511 / 0.738 | 65 | 0.5976 | 0.495 / 0.754 |
| `US_DRIVER_LICENSE` | 0.7731 | 0.697 / 0.868 | 53 | 0.7797 | 0.708 / 0.868 |
| `US_ITIN` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `US_LICENSE_PLATE` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `US_PASSPORT` | 0.7419 | 0.708 / 0.780 | 59 | 0.7680 | 0.727 / 0.814 |
| `US_SSN` | 0.8112 | 0.773 / 0.853 | 68 | 0.8056 | 0.763 / 0.853 |

</details>

<details>
<summary><code>DataikuNLP/kiji-pii-training-data:test</code></summary>

| Entity | FP32 F1 | FP32 P / R | Support | INT8 F1 | INT8 P / R |
|---|---:|---|---:|---:|---|
| `AGE` | 0.8682 | 0.789 / 0.966 | 116 | 0.8794 | 0.801 / 0.974 |
| `CREDIT_CARD` | 0.9431 | 0.892 / 1.000 | 58 | 0.9587 | 0.921 / 1.000 |
| `DATE_TIME` | 0.8276 | 0.742 / 0.936 | 141 | 0.8354 | 0.754 / 0.936 |
| `EMAIL_ADDRESS` | 0.9942 | 0.989 / 1.000 | 258 | 0.9942 | 0.989 / 1.000 |
| `IBAN_CODE` | 0.9655 | 0.942 / 0.990 | 99 | 0.9703 | 0.951 / 0.990 |
| `LOCATION` | 0.9115 | 0.878 / 0.948 | 3,630 | 0.9116 | 0.881 / 0.945 |
| `ORGANIZATION` | 0.7439 | 0.716 / 0.774 | 274 | 0.7435 | 0.712 / 0.777 |
| `PASSWORD` | 0.8732 | 0.845 / 0.903 | 103 | 0.9005 | 0.880 / 0.922 |
| `PERSON` | 0.9685 | 0.956 / 0.981 | 1,987 | 0.9665 | 0.952 / 0.981 |
| `PHONE_NUMBER` | 0.9676 | 0.968 / 0.968 | 247 | 0.9676 | 0.968 / 0.968 |
| `TITLE` | 0.0000 | 0.000 / 0.000 | 3 | 0.0000 | 0.000 / 0.000 |
| `URL` | 0.9474 | 0.936 / 0.959 | 169 | 0.9419 | 0.926 / 0.959 |
| `US_DRIVER_LICENSE` | 0.9323 | 0.900 / 0.967 | 121 | 0.9558 | 0.930 / 0.983 |
| `US_ITIN` | 0.9474 | 0.947 / 0.947 | 95 | 0.9474 | 0.947 / 0.947 |
| `US_LICENSE_PLATE` | 0.9669 | 0.959 / 0.975 | 120 | 0.9508 | 0.935 / 0.967 |
| `US_PASSPORT` | 0.9787 | 0.966 / 0.991 | 116 | 0.9746 | 0.958 / 0.991 |
| `US_SSN` | 0.9291 | 0.892 / 0.969 | 196 | 0.9337 | 0.900 / 0.969 |

</details>

<details>
<summary><code>beki/privy:test</code></summary>

| Entity | FP32 F1 | FP32 P / R | Support | INT8 F1 | INT8 P / R |
|---|---:|---|---:|---:|---|
| `AGE` | 0.9659 | 0.934 / 1.000 | 764 | 0.9610 | 0.926 / 0.999 |
| `COORDINATE` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `CREDIT_CARD` | 1.0000 | 1.000 / 1.000 | 757 | 1.0000 | 1.000 / 1.000 |
| `DATE_TIME` | 0.9975 | 0.995 / 1.000 | 5,289 | 0.9975 | 0.995 / 0.999 |
| `EMAIL_ADDRESS` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `FINANCIAL` | 0.9584 | 0.924 / 0.996 | 2,243 | 0.9541 | 0.916 / 0.996 |
| `HONORIFIC` | 0.9970 | 0.994 / 1.000 | 2,345 | 0.9972 | 0.995 / 1.000 |
| `IBAN_CODE` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `IMEI` | 1.0000 | 1.000 / 1.000 | 769 | 0.9994 | 0.999 / 1.000 |
| `IP_ADDRESS` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `LOCATION` | 0.8851 | 0.968 / 0.815 | 12,930 | 0.8850 | 0.968 / 0.815 |
| `MAC_ADDRESS` | 0.9986 | 0.997 / 1.000 | 735 | 0.9959 | 0.992 / 1.000 |
| `NRP` | 0.9958 | 0.992 / 0.999 | 3,829 | 0.9956 | 0.992 / 0.999 |
| `ORGANIZATION` | 0.9820 | 0.977 / 0.987 | 1,493 | 0.9807 | 0.974 / 0.987 |
| `PASSWORD` | 0.9348 | 0.881 / 0.996 | 720 | 0.9386 | 0.886 / 0.997 |
| `PERSON` | 0.9897 | 0.988 / 0.991 | 7,986 | 0.9878 | 0.986 / 0.990 |
| `PHONE_NUMBER` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `TITLE` | 0.9661 | 0.942 / 0.992 | 732 | 0.9655 | 0.939 / 0.993 |
| `URL` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |
| `US_BANK_NUMBER` | 0.9951 | 0.990 / 1.000 | 717 | 0.9958 | 0.992 / 1.000 |
| `US_DRIVER_LICENSE` | 0.9303 | 0.890 / 0.974 | 781 | 0.9225 | 0.875 / 0.976 |
| `US_ITIN` | 0.9811 | 0.965 / 0.997 | 754 | 0.9824 | 0.968 / 0.997 |
| `US_LICENSE_PLATE` | 0.9390 | 0.895 / 0.987 | 788 | 0.9334 | 0.885 / 0.987 |
| `US_PASSPORT` | 0.9334 | 0.893 / 0.977 | 753 | 0.9320 | 0.894 / 0.973 |
| `US_SSN` | 0.0000 | 0.000 / 0.000 | 0 | 0.0000 | 0.000 / 0.000 |

</details>

<details>
<summary><code>beki/privy:test-large</code></summary>

| Entity | FP32 F1 | FP32 P / R | Support | INT8 F1 | INT8 P / R |
|---|---:|---|---:|---:|---|
| `AGE` | 0.9447 | 0.895 / 1.000 | 3,092 | 0.9441 | 0.895 / 0.999 |
| `COORDINATE` | 0.9994 | 0.999 / 1.000 | 9,543 | 0.9996 | 0.999 / 1.000 |
| `CREDIT_CARD` | 0.9968 | 0.997 / 0.996 | 3,151 | 0.9970 | 0.997 / 0.997 |
| `DATE_TIME` | 0.9925 | 0.986 / 1.000 | 22,136 | 0.9923 | 0.985 / 0.999 |
| `EMAIL_ADDRESS` | 0.9992 | 0.999 / 1.000 | 3,142 | 0.9987 | 0.998 / 1.000 |
| `FINANCIAL` | 0.9481 | 0.907 / 0.993 | 9,360 | 0.9433 | 0.898 / 0.993 |
| `HONORIFIC` | 0.9982 | 0.997 / 1.000 | 9,584 | 0.9982 | 0.997 / 1.000 |
| `IBAN_CODE` | 0.9982 | 0.996 / 1.000 | 3,099 | 0.9982 | 0.996 / 1.000 |
| `IMEI` | 0.9998 | 1.000 / 1.000 | 3,116 | 0.9997 | 0.999 / 1.000 |
| `IP_ADDRESS` | 0.9972 | 0.994 / 1.000 | 3,185 | 0.9970 | 0.995 / 0.999 |
| `LOCATION` | 0.9764 | 0.964 / 0.990 | 43,932 | 0.9761 | 0.963 / 0.989 |
| `MAC_ADDRESS` | 0.9957 | 0.992 / 1.000 | 3,137 | 0.9951 | 0.991 / 1.000 |
| `NRP` | 0.9948 | 0.991 / 0.999 | 15,943 | 0.9948 | 0.991 / 0.998 |
| `ORGANIZATION` | 0.9794 | 0.970 / 0.989 | 6,165 | 0.9762 | 0.963 / 0.989 |
| `PASSWORD` | 0.9656 | 0.936 / 0.997 | 3,082 | 0.9599 | 0.925 / 0.997 |
| `PERSON` | 0.9887 | 0.987 / 0.990 | 32,380 | 0.9878 | 0.985 / 0.990 |
| `PHONE_NUMBER` | 0.9979 | 0.996 / 1.000 | 3,099 | 0.9974 | 0.995 / 1.000 |
| `TITLE` | 0.9744 | 0.954 / 0.995 | 3,192 | 0.9696 | 0.945 / 0.996 |
| `URL` | 0.9985 | 0.997 / 1.000 | 6,237 | 0.9985 | 0.997 / 1.000 |
| `US_BANK_NUMBER` | 0.9948 | 0.991 / 0.999 | 3,091 | 0.9937 | 0.989 / 0.998 |
| `US_DRIVER_LICENSE` | 0.9238 | 0.874 / 0.979 | 3,041 | 0.9208 | 0.869 / 0.979 |
| `US_ITIN` | 0.9821 | 0.966 / 0.999 | 2,995 | 0.9829 | 0.967 / 0.999 |
| `US_LICENSE_PLATE` | 0.9458 | 0.902 / 0.994 | 3,049 | 0.9414 | 0.894 / 0.994 |
| `US_PASSPORT` | 0.9344 | 0.889 / 0.985 | 3,044 | 0.9405 | 0.901 / 0.983 |
| `US_SSN` | 0.9982 | 0.996 / 1.000 | 2,980 | 0.9990 | 0.998 / 1.000 |

</details>

## Citation

Data citation are present in the dataset card used for this model.
If you use the model, please consider citing the papers:

```
@misc{bhargava2021generalization,
      title={Generalization in NLI: Ways (Not) To Go Beyond Simple Heuristics}, 
      author={Prajjwal Bhargava and Aleksandr Drozd and Anna Rogers},
      year={2021},
      eprint={2110.01518},
      archivePrefix={arXiv},
      primaryClass={cs.CL}
}

@article{DBLP:journals/corr/abs-1908-08962,
  author    = {Iulia Turc and
               Ming{-}Wei Chang and
               Kenton Lee and
               Kristina Toutanova},
  title     = {Well-Read Students Learn Better: The Impact of Student Initialization
               on Knowledge Distillation},
  journal   = {CoRR},
  volume    = {abs/1908.08962},
  year      = {2019},
  url       = {http://arxiv.org/abs/1908.08962},
  eprinttype = {arXiv},
  eprint    = {1908.08962},
  timestamp = {Thu, 29 Aug 2019 16:32:34 +0200},
  biburl    = {https://dblp.org/rec/journals/corr/abs-1908-08962.bib},
  bibsource = {dblp computer science bibliography, https://dblp.org}
}
```